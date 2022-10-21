import path from 'path';
import vm from 'vm';
import fs from 'fs-extra';
import fsPromises from 'fs/promises';

import {
  meteorNameToNodeName,
  meteorNameToNodePackageDir,
  nodeNameToMeteorName,
} from './helpers/helpers.js';

import { ParentArchs } from './constants.js';
import { getPackageGlobals, replaceGlobalsInFile, globalStaticImports } from './helpers/globals.js';
import packageJsContext from './helpers/package-js-context.js';
import { getExportStr, getExportMainModuleStr } from './helpers/content.js';
import MeteorArch from './meteor-arch.js';

const CONVERT_TEST_PACKAGES = true;

// TODO - we need a noop package, this isn't a good choice but it does work
const NOOP_PACKAGE_NAME = '-';

const supportedISOPackBuilds = new Map([
  ['client', 'client'], // see comment about brower/legacy/client in loadFromISOPack
  ['web.browser', 'web.browser'],
  ['web.browser.legacy', 'web.browser.legacy'],
  ['os', 'server'],
]);

const DefaultArchs = ['client', 'server'];

const DefaultClientArchs = ['client'];

const CommonJSPackageNames = new Set([
  'jquery',
  'underscore',
  'softwarerero:accounts-t9n',
  'ecmascript-runtime-client',
]);

// these packages will all be ignored, mostly they're build packages,
// the only ones that aren't have a strong dependency on modules package
const ExcludePackageNames = new Set([
  // 'ecmascript', - we need this because of how stupid meteor packages are, that they get access to the globals of every package dependency
  'typescript',
  'modules',
  'less',
  'minifiers',
  'isobuild:compiler-plugin',
  'isobuild:dynamic-import',
  'ecmascript-runtime-server', // just provides babel polyfills - we're going to require that server code be compliant?
  'isobuild:minifier-plugin',
  'standard-minifier-css',
  'standard-minifier-js',
  'dynamic-import', // this has a strong dependency on modules
  'hot-module-replacement', // this has a strong dependency on modules
]);

export const packageMap = new Map();

const SynonymArchs = new Map([
  ['legacy', 'web.browser.legacy'],
  ['modern', 'web.browser'],
]);

// these are the ultimate leaf architectures we support - there is no such thing as a "client" build.
const LeafArchs = [
  'web.browser.legacy',
  'web.browser',
  'web.cordova',
  'server',
];

function sortImports(imports) {
  imports.sort((a, b) => {
    const aIsAbsolute = a.match(/^[@/]/);
    const bIsAbsolute = b.match(/^[@/]/);
    if (aIsAbsolute && bIsAbsolute) {
      return 0;
    }
    if (!aIsAbsolute && !bIsAbsolute) {
      return 0;
    }
    if (aIsAbsolute && !bIsAbsolute) {
      return -1;
    }
    if (!aIsAbsolute && bIsAbsolute) {
      return 1;
    }
    return 0;
  });
  return imports;
}

function getImportStr(importsSet, isCommon) {
  if (isCommon) {
    return sortImports(Array.from(importsSet)).map((imp) => {
      const suffix = packageMap.get(nodeNameToMeteorName(imp))?.isLazy() ? '/__defineOnly.js' : '';
      return `require("${imp}${suffix}");`;
    }).join('\n');
  }

  return sortImports(Array.from(importsSet)).map((imp) => {
    const suffix = packageMap.get(nodeNameToMeteorName(imp))?.isLazy() ? '/__defineOnly.js' : '';
    return `import "${imp}${suffix}";`;
  }).join('\n');
}

const meteorVersionPlaceholderSymbol = Symbol('meteor-version-placeholder');

class MeteorPackage {
  #folderName;

  #meteorName;

  #nodeName;

  #version;

  #description;

  #testPackage;

  #filePrefix = '';

  #startedWritingTest = false;

  #weakPackages = new Set();

  #dependencies = {};

  #peerDependencies = {};

  #optionalDependencies = {};

  #archs = new Map();

  #allPackages = new Set();

  // non weak, non unordered
  #immediateDependencies = new Set();

  #imports = {};

  #isLazy = false;

  #waitingWrite = [];

  #isoResourcesToCopy = new Map();

  #folderPath;

  #isISOPack = false;

  static PackageNameToFolderPaths = new Map();

  #loadedPromise;

  #loadedResolve;

  #exportCondition;

  #writtenPromise;

  #alreadyWritten;

  #writtenResolve;

  #isTest;

  #hasTests;

  isFullyLoaded;

  #outputParentFolder;

  #options;

  // TODO: we're passing around too much global state (outputParentFolder, options)
  constructor(meteorName, isTest, outputParentFolder, options = {}) {
    this.#meteorName = meteorName;
    this.#outputParentFolder = outputParentFolder;
    this.#options = options;
    this.#writtenPromise = new Promise((resolve) => {
      this.#writtenResolve = resolve;
    });
    this.#loadedPromise = new Promise((resolve) => {
      this.#loadedResolve = resolve;
    });
    this.#isTest = !!isTest;
    if (!isTest) {
      this.#testPackage = new MeteorPackage('', true, outputParentFolder, options);
    }
    else {
      this.#filePrefix = '__test';
    }

    if (this.#meteorName !== 'meteor') {
      // all meteor packages have an implicit dependency on the meteor package
      // see comment in tools/isobuild/package-api.js
      this.addMeteorDependencies(['meteor']);
    }
  }

  getArch(archName) {
    let actualArchName = archName;
    if (SynonymArchs.has(actualArchName)) {
      actualArchName = SynonymArchs.get(actualArchName);
    }
    if (!this.#archs.has(actualArchName)) {
      this.#archs.set(
        actualArchName,
        new MeteorArch(
          actualArchName,
          ParentArchs.has(actualArchName) ? this.getArch(ParentArchs.get(actualArchName)) : undefined,
        ),
      );
    }
    return this.#archs.get(actualArchName);
  }

  getAllArchs() {
    return Array.from(this.#archs.values());
  }

  getActiveLeafArchs() {
    return Array.from(new Set(this.getLeafArchs().map((arch) => arch.getActiveArch())));
  }

  getLeafArchs() {
    return LeafArchs.map((archName) => this.getArch(archName));
  }

  getArchs(archNames) {
    let allArchNames = archNames;
    if (!archNames?.length) {
      allArchNames = DefaultArchs;
    }

    return allArchNames.map((archName) => this.getArch(archName));
  }

  get folderName() {
    return this.#meteorName.replace(':', '_');
  }

  static meteorNameToNodeName(name) {
    return meteorNameToNodeName(name);
  }

  static nodeNameToMeteorName(name) {
    if (name.startsWith('@meteor/')) {
      return name.split('/')[1];
    }
    return name.slice(1).split('/').join(':');
  }

  isLazy() {
    return this.#isLazy;
  }

  isCommon() {
    if (this.#isTest) {
      return CommonJSPackageNames.has(this.#meteorName.replace('test:', ''));
    }
    return CommonJSPackageNames.has(this.#meteorName);
  }

  setBasic({
    name,
    description,
    version,
    prodOnly,
    testOnly,
    devOnly,
  }) {
    this.#meteorName = name || this.#meteorName;
    this.#nodeName = MeteorPackage.meteorNameToNodeName(name || this.#meteorName);
    this.#description = description;

    // semver doesn't support _
    this.#version = version.replace('_', '-');
    this.#testPackage.#meteorName = `test:${this.#meteorName}`;

    if ([prodOnly, devOnly, testOnly].filter(Boolean).length > 1) {
      throw new Error('Package can\'t be any combination of prod, dev or test only');
    }

    if (prodOnly) {
      this.#exportCondition = 'production';
    }
    if (testOnly) {
      this.#exportCondition = 'test';
    }
    if (devOnly) {
      this.#exportCondition = 'development';
    }
  }

  addExports(symbols, archNames, opts) {
    const actualArchs = this.getArchs(archNames);
    if (!opts?.testOnly) {
      // TODO: we probably need to export these
      symbols.forEach((symbol) => {
        actualArchs.forEach((arch) => {
          arch.addExport(symbol);
        });
      });
    }
  }

  addNpmDeps(deps) {
    Object.assign(this.#dependencies, deps);
  }

  addImport(item, archNames, opts = { testOnly: false }) {
    if (opts.testOnly) {
      this.#hasTests = true;
      this.#testPackage.addImport(item, archNames);
      return;
    }
    let resolvedArchNames = archNames;
    // hack for old packages (iron:*) that add html files to the server by omitting the archs arg.
    if (!resolvedArchNames && (item.endsWith('.html') || item.endsWith('.css'))) {
      resolvedArchNames = DefaultClientArchs;
    }
    const actualArchs = this.getArchs(resolvedArchNames);
    actualArchs.forEach((arch) => {
      arch.addImport(item);
    });
  }

  addAssets(files, archNames) {
    const actualArchs = this.getArchs(archNames);
    files.forEach((file) => {
      actualArchs.forEach((arch) => {
        arch.addAsset(file);
      });
    });
  }

  addMeteorDependencies(packages, archNames, opts) {
    if (opts?.testOnly) {
      this.#hasTests = true;
      this.#testPackage.addMeteorDependencies(packages, archNames);
      return;
    }
    let deps = this.#dependencies;
    if (opts?.unordered) {
      // TODO: I think this is a problem with the local file install.
      deps = this.#peerDependencies;
    }
    else if (opts?.weak) {
      deps = this.#optionalDependencies;
    }
    const actualArchs = this.getArchs(archNames);
    packages.forEach((dep) => {
      const [name] = dep.split('@');
      if (ExcludePackageNames.has(name)) {
        return;
      }
      const nodeName = MeteorPackage.meteorNameToNodeName(name);

      if (opts?.weak) {
        actualArchs.forEach((arch) => arch.addPreloadPackage(nodeName));
        this.#weakPackages.add(name);
      }
      else {
        this.#allPackages.add(name);
      }
      if (opts?.unordered) {
        actualArchs.forEach((arch) => arch.addUnorderedPackage(nodeName));
      }
      // TODO should probably NEVER use version, since we can't do resolution the way we want (at least until all versions are published to npm)
      deps[nodeName] = meteorVersionPlaceholderSymbol;
      if (!opts?.unordered && !opts?.testOnly && !opts?.weak) {
        // TODO check comment in tools/isobuild/package-api.js
        this.addImport(nodeName, archNames);
        // TODO: do we actually need this.
        this.#immediateDependencies.add(name);
      }
      // TODO: other opts?
    });
  }

  addImplies(packages, archs) {
    const actualArchs = this.getArchs(archs);
    packages.forEach((dep) => {
      const [name] = dep.split('@');
      if (ExcludePackageNames.has(name)) {
        return;
      }
      this.#allPackages.add(name);
      const nodeName = MeteorPackage.meteorNameToNodeName(name);

      // we should probably NEVER use version, since we can't do resolution the way we want (at least until all versions are published to npm)
      this.#dependencies[nodeName] = meteorVersionPlaceholderSymbol;
      this.#immediateDependencies.add(name);
      actualArchs.forEach((arch) => {
        // TODO: should this be the node name? An implication is a purely meteor concept, used exclusively in the conversion
        arch.addImpliedPackage(nodeName);
      });
    });
  }

  setMainModule(file, archNames, opts = { testOnly: false }) {
    if (opts.testOnly) {
      this.#hasTests = true;
      this.#testPackage.setMainModule(file, archNames);
      return;
    }
    if (opts.lazy) {
      this.#isLazy = true;
    }
    const actualArchs = this.getArchs(archNames);
    actualArchs.forEach((arch) => {
      arch.setMainModule(`./${file}`);
    });
  }

  // eslint-disable-next-line
  getDependency(meteorName) {
    return packageMap.get(meteorName);
  }

  getExportsForPackageJSON() {
    const ret = {
      ...(Object.fromEntries(this.getLeafArchs().map((arch) => [
        arch.getExportArchName(),
        {
          import: `./${this.#filePrefix}__${arch.getActiveArch().archName}.js`,
          ...(!this.isCommon() && { require: `./${this.#filePrefix}__${arch.getActiveArch().archName}.cjs` }),
        },
      ]))),
      default: './__noop.js',
    };

    if (this.#exportCondition) {
      return {
        [this.#exportCondition]: ret,
        default: './__noop.js',
      };
    }
    return ret;
  }

  archsToObject(fn) {
    return {
      ...(Object.fromEntries(this.getAllArchs().map((arch) => [
        arch.archName,
        Array.from(fn(arch)),
      ]).filter(([, values]) => values.length))),
    };
  }

  toJSON() {
    const exportedVars = (Object.fromEntries(this.getAllArchs().map((arch) => [
      arch.archName,
      arch.getExports(true),
    ]).filter(([, values]) => values.length)));
    return {
      name: this.#nodeName,
      version: this.#version,
      description: this.#description,
      type: this.isCommon() ? 'commonjs' : 'module',
      dependencies: MeteorPackage.rewriteDependencies(this.#dependencies),
      devDependencies: CONVERT_TEST_PACKAGES ? MeteorPackage.rewriteDependencies(this.#testPackage.#dependencies) : {},
      peerDependencies: MeteorPackage.rewriteDependencies(this.#peerDependencies),
      optionalDependencies: MeteorPackage.rewriteDependencies(this.#optionalDependencies),
      exports: {
        ...(this.#hasTests ? {
          './__test.js': this.#testPackage.getExportsForPackageJSON(),
        } : {}),
        '.': this.getExportsForPackageJSON(),
        './*': './*',
      },
      imports: this.#imports,
      meteorTmp: {
        dependencies: Object.fromEntries(Array.from(this.#allPackages).map((packageName) => [
          meteorNameToNodeName(packageName), this.getDependency(packageName).#version,
        ])),
        exportedVars,
        implies: this.archsToObject((arch) => arch.getImpliedPackages(true)),
      },
      meteor: {
        ...(this.#isLazy && { lazy: true }),
        // the combination of all weak dependencies of this package
        // AND all the ESM dependencies of this package if it is CJS
        // this is required since right now require(esm) just exports
        // the pre-defined package.
        preload: {
          ...(Object.fromEntries([
            ...(this.getAllArchs().map((arch) => [
              arch.archName,
              Array.from(arch.getPreloadPackages(true)),
            ]).filter(([, values]) => values.length)),
          ])),
        },
        unordered: {
          ...(Object.fromEntries(this.getAllArchs().map((arch) => [
            arch.archName,
            Array.from(arch.getUnorderedPackages(true)),
          ]).filter(([, values]) => values.length))),
        },
        assets: {
          ...(Object.fromEntries(this.getAllArchs().map((arch) => [
            arch.archName,
            arch.getAssets(true),
          ]).filter(([, values]) => values.length))),
        },
      },
    };
  }

  getImportedGlobalsMaps(globals) {
    const archNames = this.getLeafArchs().map((arch) => arch.archName);
    const ret = Object.fromEntries(archNames.map((archName) => [
      archName,
      new Map(),
    ]));
    globals.forEach((global) => {
      if (globalStaticImports.has(global) && globalStaticImports.get(global) !== this.#nodeName) {
        archNames.forEach((arch) => {
          ret[arch].set(global, globalStaticImports.get(global));
        });
      }
    });
    Object.keys(this.#dependencies)
      .forEach((dep) => {
        const packageName = MeteorPackage.nodeNameToMeteorName(dep);
        const meteorPackage = this.getDependency(packageName);
        if (!meteorPackage) {
          // it wasn't a meteor dep.
          return;
        }
        const depGlobals = meteorPackage.getImportedGlobalsMaps(globals);
        Object.entries(depGlobals).forEach(([archName, archGlobals]) => {
          if (!ret[archName]) {
            return;
          }
          archGlobals.forEach((providingDep, exp) => {
            ret[archName].set(exp, providingDep);
          });
        });
        archNames.forEach((archName) => {
          meteorPackage.getImplies(archName)
            .forEach((imp) => {
              const impPackageName = MeteorPackage.nodeNameToMeteorName(imp);
              const impliedPackage = this.getDependency(impPackageName);
              impliedPackage.getExportedVars(archName)
                .forEach((exp) => {
                  if (globals.has(exp)) {
                    ret[archName].set(exp, imp);
                  }
                });
            });
          meteorPackage.getExportedVars(archName)
            .forEach((exp) => {
              if (globals.has(exp)) {
                ret[archName].set(exp, dep);
              }
            });
        });
      });
    return ret;
  }

  // TODO: return type changes depending on whether we pass in a name.
  getImplies(archName) {
    if (!archName) {
      return Array.from(new Set(this.getAllArchs().flatMap((arch) => Array.from(arch.getImpliedPackages()))));
    }
    return this.getArch(archName)?.getImpliedPackages() || new Set();
  }

  getExportedVars(archName) {
    if (!archName) {
      return Array.from(new Set(this.getAllArchs().flatMap((arch) => arch.getExports())));
    }
    return this.getArch(archName).getExports();
  }

  async writeDependencies() {
    await this.#loadedPromise;
    if (this.#alreadyWritten) {
      return true;
    }
    this.#alreadyWritten = true;
    await Promise.all(Array.from(this.#immediateDependencies).map((p) => this.getDependency(p).writeToNpmModule()));
    return false;
  }

  async getImportTreeForPackageAndClean(outputFolder) {
    const archsForFiles = new Map();
    const exportedMap = new Map();
    await Promise.all(this.getActiveLeafArchs().map((arch) => arch.getImportTreeForPackageAndClean(
      outputFolder,
      archsForFiles,
      this.isCommon(),
      exportedMap,
    )));

    return { archsForFiles, exportedMap };
  }

  async writeEntryPoints(outputFolder) {
    return Promise.all([
      ...this.#isLazy ? [
        fsPromises.writeFile(
          `${outputFolder}/${this.#filePrefix}__defineOnly.js`,
          `Package["${this.#meteorName}"] = {}`,
        ),
      ] : [],
      ...this.getActiveLeafArchs().map(async (arch) => {
        if (this.#isTest && arch.isNoop(false)) {
          return false;
        }
        return Promise.all([
          fsPromises.writeFile(
            `${outputFolder}/${this.#filePrefix}__${arch.archName}.js`,
            [
              getImportStr(arch.getImports(), this.isCommon()),
              ...(arch.getMainModule()
                ? [await getExportMainModuleStr(this.#meteorName, arch.getMainModule(), outputFolder, this.isCommon())]
                : []
              ),
              getExportStr(
                this.#meteorName,
                arch.archName,
                arch.getExports(),
                arch.getImports(),
                this.isCommon(),
                (name) => this.getDependency(name),
                arch.getMainModule(),
              ),
            ].join('\n'),
          ),
          !this.isCommon() && fsPromises.writeFile(
            `${outputFolder}/${this.#filePrefix}__${arch.archName}.cjs`,
            `module.exports = Package["${this.#meteorName}"];`,
          ),
        ]);
      }),
      this.#exportCondition ? fsPromises.writeFile(`${outputFolder}/__noop.js`, 'export {};') : undefined,
    ]);
  }

  async writeToNpmModule() {
    // TODO: rework this entire function
    let state = 0;
    try {
      const shortCircuit = await this.writeDependencies();
      if (shortCircuit) {
        return;
      }
      if (CONVERT_TEST_PACKAGES && this.#hasTests && !this.#startedWritingTest) {
        this.#startedWritingTest = true;
        await this.#testPackage.writeDependencies();
      }
      state = 1;
      const outputFolder = path.resolve(`${this.#outputParentFolder}/${meteorNameToNodePackageDir(this.#meteorName)}`);
      if (this.#isISOPack) {
        await this.#copyISOPackResources(outputFolder);
      }
      else {
        const actualPath = await fs.realpath(this.#folderPath);

        // TODO: now we're able to detect the entire import tree, we should only copy those files (plus assets + package.js)
        // the only problem here is we'd have to parse and copy the tree as one step since the tree may require cleaning.
        await fs.copy(
          actualPath,
          outputFolder,
          {
            filter(src) {
              return !src.includes('.npm') && !src.includes('package.json');
            },
          },
        );
      }
      state = 2;
      const { archsForFiles } = await this.getImportTreeForPackageAndClean(outputFolder);

      const { all: globalsByFile, assigned: packageGlobalsByFile } = await getPackageGlobals(
        this.isCommon(),
        outputFolder,
        archsForFiles,
      );
      const allGlobals = new Set(Array.from(globalsByFile.values()).flatMap((v) => Array.from(v)));
      const packageGlobals = new Set(Array.from(packageGlobalsByFile.values()).flatMap((v) => Array.from(v)));
      const importedGlobalsByArch = this.getImportedGlobalsMaps(allGlobals);

      // these are all the globals USED in the package. Not just those assigned.
      // TODO: this should go away, but is needed for the exports/require/module hack below
      // TODO: this probably isn't 'correct' - since it doesn't really consider per-arch "bad package globals"
      const badPackageGlobals = Array.from(allGlobals)
        .filter((global) => !Object.values(importedGlobalsByArch).find((archMap) => archMap.has(global)));

      const serverOnlyImportsSet = new Set();
      await Promise.all(Array.from(globalsByFile.entries()).map(([file, globals]) => replaceGlobalsInFile(
        outputFolder,
        globals,
        file,
        importedGlobalsByArch,
        this.isCommon(),
        (name) => this.getDependency(name),
        archsForFiles.get(file.replace(outputFolder, '.')),
        packageGlobals,
        serverOnlyImportsSet,
      )));
      state = 3;
      serverOnlyImportsSet.forEach((serverOnlyImport) => {
        this.#imports[`#${serverOnlyImport}`] = {
          node: serverOnlyImport,
          default: NOOP_PACKAGE_NAME,
        };
      });
      if (CONVERT_TEST_PACKAGES && this.#hasTests) {
        // TODO: puke - this entire chunk.
        const { archsForFiles: testArchsForFiles } = await this.#testPackage.getImportTreeForPackageAndClean(outputFolder);
        Array.from(testArchsForFiles.keys()).forEach((key) => {
          if (archsForFiles.has(key)) {
            testArchsForFiles.delete(key);
          }
        });
        const { all: testGlobalsByFolder, assigned: packageTestGlobalsByFile } = await getPackageGlobals(
          this.isCommon(),
          outputFolder,
          testArchsForFiles,
        );
        const packageTestGlobals = new Set(Array.from(packageTestGlobalsByFile.values()).flatMap((v) => Array.from(v)));
        const testServerOnlyImportsSet = new Set();
        const allTestGlobals = new Set(Array.from(testGlobalsByFolder.values()).flatMap((v) => Array.from(v)));
        const importedTestGlobalsByArch = this.#testPackage.getImportedGlobalsMaps(allTestGlobals);
        await Promise.all(Array.from(testGlobalsByFolder.entries()).map(([file, globals]) => replaceGlobalsInFile(
          outputFolder,
          globals,
          file,
          importedTestGlobalsByArch,
          this.isCommon(),
          (name) => this.getDependency(name),
          testArchsForFiles.get(file.replace(outputFolder, '.')),
          new Set([...Array.from(packageTestGlobals), ...Array.from(packageGlobals)]),
          testServerOnlyImportsSet,
        )));
        await this.#testPackage.writeEntryPoints(outputFolder);
      }
      if (badPackageGlobals.length || this.getExportedVars().length) {
        const exportNamesSet = new Set([
          ...this.getExportedVars(),
          ...badPackageGlobals,
          ...packageGlobals,
        ]);

        const hasRequire = exportNamesSet.has('require');
        const hasExports = exportNamesSet.has('exports');
        const hasModule = exportNamesSet.has('module');
        const hasNpm = exportNamesSet.has('Npm');
        const hasAssets = exportNamesSet.has('Assets');
        exportNamesSet.delete('require');
        exportNamesSet.delete('module');
        exportNamesSet.delete('Npm');
        exportNamesSet.delete('Assets');
        if (hasAssets) {
          this.#imports['#assets'] = {
            node: `./${this.#filePrefix}__server_assets.js`,
            default: NOOP_PACKAGE_NAME,
          };
          await fs.writeFile(
            `${outputFolder}/${this.#filePrefix}__server_assets.js`,
            [
              'import fs from \'fs\';',
              'import fsPromises from \'fs/promises\';',
              'import Fiber from \'fibers\';',
              'import path from \'path\';',
              'const basePath = path.dirname(import.meta.url).replace(\'file:\', \'\')',
              'export default {',
              '  getText(file) {',
              '    return Fiber.current ? Promise.await(fsPromises.readFile(path.join(basePath, file))).toString() : fs.readFileSync(path.join(basePath, file)).toString();',
              '  }',
              '};',
            ].join('\n'),
          );
        }
        if ((hasRequire || hasExports) && this.getArch('server')?.getMainModule()) {
          console.warn(`esm module ${this.#meteorName} using exports or require, this probably wont work`);
        }
        if ((hasModule || hasNpm || hasRequire) && !this.isCommon()) {
          this.#imports['#module'] = {
            node: './__server_module.js',
            default: './__client_module.js',
          };
          await Promise.all([
            fsPromises.writeFile(
              `${outputFolder}/__client_module.js`,
              `export default {
                createRequire() {return require}
              };
              `,
            ),
            fsPromises.writeFile(
              `${outputFolder}/__server_module.js`,
              'export { default } from "node:module"',
            ),
          ]);
        }
        if (this.isCommon()) {
          await fsPromises.writeFile(
            `${outputFolder}/__globals.js`,
            // TODO support assets for cjs
            Array.from(exportNamesSet).map((name) => `module.exports.${name} = undefined;`).join('\n'),
          );
        }
        else {
          await fsPromises.writeFile(
            `${outputFolder}/__globals.js`,
            [
              ...(hasModule || hasNpm || hasRequire ? ['import module from "#module";'] : []),
              ...hasAssets ? ['import Assets from \'#assets\''] : [],
              'export default {',
              ...(exportNamesSet.size ? [`  ${Array.from(exportNamesSet).map((name) => `${name}: undefined`).join(',\n  ')},`] : []),
              ...(hasNpm ? ['  Npm: { require: module.createRequire(import.meta.url) },'] : []),
              ...(hasModule ? ['  module: { id: import.meta.url },'] : []),
              ...(hasRequire ? ['  require: module.createRequire(import.meta.url),'] : []),
              ...(hasAssets ? ['Assets'] : []),
              '}',
            ].join('\n'),
          );
        }
      }
      state = 4;
      state = 5;
      await Promise.all([
        fsPromises.writeFile(
          `${outputFolder}/package.json`,
          JSON.stringify(this.toJSON(), null, 2),
        ),
        this.writeEntryPoints(outputFolder),
      ]);
      state = 6;
    }
    catch (error) {
      console.log(this.#meteorName, this.#outputParentFolder, state);
      console.error(error);
      throw error;
    }
    finally {
      this.#writtenResolve();
    }
  }

  async #copyISOPackResources(outputFolder) {
    await fs.ensureDir(outputFolder);
    return Promise.all(Array.from(this.#isoResourcesToCopy.entries()).map(async ([dest, src]) => {
      await fs.ensureDir(path.dirname(path.join(outputFolder, dest)));
      return fsPromises.copyFile(path.join(this.#folderPath, src), path.join(outputFolder, dest));
    }));
  }

  async #loadISOBuild(json, clientOrServer) {
    json.uses.forEach(({ package: packageName, weak, unordered }) => {
      this.addMeteorDependencies([packageName], [clientOrServer], { weak, unordered });
    });
    json.resources.forEach(({
      path: aPath,
      file,
      type,
      servePath,
    }) => {
      let actualPath = aPath;
      if (!actualPath && type !== 'source') {
        // iron_dynamic-template has a compiled version of dynamic_template.html I think
        // this needs to be imported as normal, but it doesn't have a "path"
        actualPath = servePath.split('/').slice(3).join('/');
        this.addImport(`./${actualPath}`, [clientOrServer]);
      }
      if (type === 'source' && actualPath.startsWith('/packages/')) {
        actualPath = actualPath.replace('/packages/', `/${clientOrServer}/`);
      }
      this.#isoResourcesToCopy.set(actualPath, file);
    });
    if (json.node_modules) {
      const npmShrinkwrapJsonPath = path.join(this.#folderPath, json.node_modules, '.npm-shrinkwrap.json');
      if (await fs.pathExists(npmShrinkwrapJsonPath)) {
        const npmShrinkwrapJson = JSON.parse((await fsPromises.readFile(npmShrinkwrapJsonPath)).toString());
        Object.entries(npmShrinkwrapJson.dependencies).forEach(([name, { version }]) => {
          this.#dependencies[name] = version;
        });
      }
    }
    json.resources
      .filter(({ type, fileOptions: { lazy } = {} }) => type === 'source' && lazy !== true)
      .forEach(({ path: aPath }) => {
        let actualPath = aPath;
        if (actualPath.startsWith('/packages/')) {
          actualPath = actualPath.replace('/packages/', `/${clientOrServer}/`);
        }
        this.addImport(`./${actualPath}`, [clientOrServer]);
      });

    json.resources
      .filter(({ type }) => type === 'asset')
      .forEach(({ path: aPath }) => {
        this.addAssets([aPath], [clientOrServer]);
      });
    if (json.declaredExports) {
      json.declaredExports.forEach(({ name, testOnly }) => {
        if (!testOnly) {
          this.addExports([name], [clientOrServer]);
        }
      });
    }
  }

  async loadFromISOPack(meteorInstall, ...otherPaths) {
    this.#isISOPack = true;
    const folderName = (this.#meteorName).split(':').join('_');
    if (!await fs.pathExists(meteorInstall)) {
      throw new Error('Meteor not installed');
    }
    const basePath = path.join(meteorInstall, 'packages', folderName);
    if (!await fs.pathExists(basePath)) {
      throw new Error(`${this.#meteorName} Package not installed by meteor`);
    }
    const names = (await fsPromises.readdir(basePath)).filter((name) => !name.startsWith('.'));
    const fullFolder = path.join(basePath, names.slice(-1)[0]);
    this.#folderPath = fullFolder;
    const isopack = JSON.parse((await fsPromises.readFile(path.join(fullFolder, 'isopack.json'))).toString())['isopack-2'];
    this.setBasic({
      name: isopack.name,
      description: isopack.summary,
      version: isopack.version,
      prodOnly: isopack.prodOnly,
      devOnly: isopack.devOnly,
      testOnly: isopack.testOnly,
    });
    const builds = isopack.builds.filter((build) => supportedISOPackBuilds.has(build.arch));
    // I'm not totally sure this is correct, but iron:router is an example of this
    // it declares only a web.browser build but should be exporting it's symbols for web.browser and web.browser.legacy
    // es5-shim is the opposite, it has totally different builds for web.browser and web.browser.legacy
    if (!builds.find(({ arch }) => arch === 'web.browser.legacy')) {
      const webBrowserBuild = builds.find(({ arch }) => arch === 'web.browser');
      if (webBrowserBuild) {
        webBrowserBuild.arch = 'client';
      }
    }
    await Promise.all(builds.map(async (build) => {
      const buildJson = JSON.parse((await fsPromises.readFile(path.join(fullFolder, build.path))).toString());
      return this.#loadISOBuild(buildJson, supportedISOPackBuilds.get(build.arch));
    }));

    // first make sure all impled or used packages are loaded
    this.#waitingWrite = (await Promise.all(
      Array.from(this.#allPackages).map((packageName) => MeteorPackage.ensurePackage(
        packageName,
        this.#outputParentFolder,
        this.#options,
        meteorInstall,
        ...otherPaths,
      )),
    )).filter(Boolean);
  }

  async ensurePackages(meteorInstall, ...otherPaths) {
    // first make sure all impled or used packages are loaded
    this.#waitingWrite = (await Promise.all([
      ...Array.from(this.#allPackages).map(async (packageName) => {
        try {
          return await MeteorPackage.ensurePackage(
            packageName,
            this.#outputParentFolder,
            this.#options,
            meteorInstall,
            ...otherPaths,
          );
        }
        catch (e) {
          e.message = `Couldn't ensure ${packageName} because ${e.message}`;
          throw e;
        }
      }),
      ...Array.from(this.#weakPackages).map(async (packageName) => {
        try {
          return await MeteorPackage.ensurePackage(
            packageName,
            this.#outputParentFolder,
            this.#options,
            meteorInstall,
            ...otherPaths,
          );
        }
        catch (e) {
          e.message = `Couldn't ensure weak dependency ${packageName} because ${e.message}`;
          console.warn(e.message);
          return false;
        }
      }),
    ])).filter(Boolean);

    // now we've loaded all our dependencies, time to make sure all our ESM modules (if we're CJS) are listed as preload
    if (this.isCommon()) {
      this.#allPackages.forEach((packageName) => {
        const requiredPackage = this.getDependency(packageName);
        if (!requiredPackage.isCommon()) {
          const nodeName = meteorNameToNodeName(packageName);
          this.getAllArchs().forEach((arch) => {
            if (arch.getImports(true).has(nodeName)) {
              arch.addPreloadPackage(nodeName);
            }
          });
        }
      });
    }
  }

  async loadFromNodeJSON(pathToJson, meteorInstall, ...packagesPaths) {
    try {
      const packageJSON = JSON.parse((await fsPromises.readFile(pathToJson)).toString());
      this.setBasic({
        name: nodeNameToMeteorName(packageJSON.name),
        version: packageJSON.version,
        description: packageJSON.description,
      });

      if (packageJSON.meteorTmp?.exportedVars) {
        Object.entries(packageJSON.meteorTmp.exportedVars).forEach(([arch, symbols]) => {
          this.addExports(symbols, [arch]);
        });
      }

      if (packageJSON.meteorTmp?.implies) {
        Object.entries(packageJSON.meteorTmp.implies).forEach(([arch, nodePackages]) => {
          this.addImplies(nodePackages.map((nodeName) => nodeNameToMeteorName(nodeName)), [arch]);
        });
      }
      if (!packageJSON.meteorTmp?.dependencies) {
        return false;
      }
      Object.entries(packageJSON.meteorTmp.dependencies).forEach(([nodeName, version]) => {
        const meteorName = nodeNameToMeteorName(nodeName);
        this.#allPackages.add(meteorName);
      });
      this.#loadedResolve();
      this.#alreadyWritten = true;

      await this.ensurePackages(meteorInstall, ...packagesPaths);
      return true;
    }
    catch (e) {
      console.error(e);
      return false;
    }
  }

  async loadFromMeteorPackage(meteorInstall, ...otherPaths) {
    try {
      this.isFullyLoaded = true;
      const packageJsPath = await this.findPackageJs(...otherPaths);
      if (!packageJsPath) {
        await this.loadFromISOPack(meteorInstall, ...otherPaths);
        return;
      }
      this.#folderPath = path.dirname(packageJsPath);
      const script = new vm.Script((await fsPromises.readFile(packageJsPath)).toString());
      const context = packageJsContext(this);
      try {
        script.runInNewContext(context);
        await this.ensurePackages(meteorInstall, ...otherPaths);
        if (CONVERT_TEST_PACKAGES && this.#hasTests) {
          await this.#testPackage.ensurePackages(meteorInstall, ...otherPaths);
        }
      }
      catch (e) {
        console.error(`problem parsing ${this.#meteorName}`);
        throw e;
      }
      packageMap.set(this.#meteorName, this);
      // next, find all the direct dependencies and see what they imply. Then add those to our dependencies
      Object.keys(this.#dependencies)
        .forEach((dep) => {
          const importedPackage = this.getDependency(MeteorPackage.nodeNameToMeteorName(dep));
          if (!importedPackage) {
            // was't a meteor package...
            return;
          }
          this.getAllArchs().forEach((arch) => {
            const impliedSet = importedPackage.getImplies(arch.archName);
            impliedSet.forEach((name) => this.addImport(name, [arch.archName]));
          });
        });
    }
    catch (error) {
      console.log(this.#meteorName || this.#folderName);
      console.error(error);
      throw error;
    }
    finally {
      this.#loadedResolve();
      this.#testPackage.#loadedResolve();
    }
  }

  async convert(meteorInstall, ...packagesPaths) {
    await this.loadFromMeteorPackage(meteorInstall, ...packagesPaths);
    await this.writeToNpmModule();
  }

  async findPackageJs(...packagesPaths) {
    const folders = MeteorPackage.foldersToSearch(...packagesPaths);
    const tempPrioMap = new Map();
    if (!MeteorPackage.PackageNameToFolderPaths.size) {
      const allFolders = (await Promise.all(folders.map(async (folder) => {
        if (!await fs.pathExists(folder)) {
          return [];
        }
        const innerFolders = await fsPromises.readdir(folder, { withFileTypes: true });
        return innerFolders.filter((innerFolder) => innerFolder.isDirectory).map((innerFolder) => path.join(folder, innerFolder.name));
      }))).flat();
      (await Promise.all(allFolders.map(async (folder, index) => {
        const packageJsPath = path.join(folder, 'package.js');
        if (!await fs.pathExists(packageJsPath)) {
          return false;
        }
        const packageJs = (await fs.readFile(packageJsPath)).toString();
        const hasName = packageJs.match(/Package\.describe\(\{[^}]+['"]?name['"]?\s*:\s*['"]([a-zA-Z0-9:-]+)["']/);
        const name = hasName ? hasName[1] : folder.split('/').slice(-1)[0];
        if (!tempPrioMap.has(name) || tempPrioMap.get(name) > index) {
          tempPrioMap.set(name, index);
          MeteorPackage.PackageNameToFolderPaths.set(name, packageJsPath);
        }
      })));
    }
    return MeteorPackage.PackageNameToFolderPaths.get(this.#meteorName);
  }

  static rewriteDependencies(dependencies) {
    return Object.fromEntries(Object.entries(dependencies).map(([name, version]) => {
      if (version === meteorVersionPlaceholderSymbol) {
        const importedPackage = packageMap.get(MeteorPackage.nodeNameToMeteorName(name));
        if (!importedPackage) {
          return undefined; // TODO?
          throw new Error(`depending on missing package ${MeteorPackage.nodeNameToMeteorName(name)}`);
        }
        // didn't know you could call a private member of something other than this...
        return [name, importedPackage.#version];
      }
      return [name, version];
    }).filter(Boolean));
  }

  static foldersToSearch(...packagesPaths) {
    // sorta hack, until we move to using ISOPacks for core/non-core packages.
    // the meteor repo has three folders for packages, rather than listing them all (which is the better option tbh)
    // we try appending non-core and dependencies to all paths.
    return packagesPaths.flatMap((subPath) => [subPath, path.join(subPath, 'non-core'), path.join(subPath, 'deprecated')]);
  }

  static async alreadyConvertedPath(name, outputParentFolder) {
    const packagePath = meteorNameToNodePackageDir(name);
    const actualPath = path.join(outputParentFolder, packagePath, 'package.json');
    if (await fs.pathExists(actualPath)) {
      return actualPath;
    }
    return false;
  }

  static async ensurePackage(name, outputParentFolder, options, meteorInstall, ...packagesPaths) {
    if (!packageMap.has(name)) {
      const meteorPackage = new MeteorPackage(name, false, outputParentFolder, options);
      packageMap.set(name, meteorPackage);
      if (!options.forceRefresh) {
        const alreadyConvertedPath = await MeteorPackage.alreadyConvertedPath(name, outputParentFolder);
        if (alreadyConvertedPath) {
          const isGood = await meteorPackage.loadFromNodeJSON(alreadyConvertedPath, meteorInstall, ...packagesPaths);
          if (isGood) {
            return false;
          }
        }
      }
      await meteorPackage.loadFromMeteorPackage(meteorInstall, ...packagesPaths);
      return meteorPackage;
    }

    // if we aren't building a package, return false
    return false;
  }
}

// TODO: we're overloading name here.
export async function convertPackage({
  meteorName,
  meteorInstall,
  outputParentFolder,
  otherPackageFolders,
  options = {},
}) {
  const absoluteOutputParentFolder = path.resolve(outputParentFolder);
  if (ExcludePackageNames.has(meteorName)) {
    return;
  }
  if (packageMap.has(meteorName) && this.getDependency(meteorName).isFullyLoaded) {
    return;
  }
  const meteorPackage = new MeteorPackage(meteorName, false, absoluteOutputParentFolder, options);
  packageMap.set(meteorName, meteorPackage);
  await meteorPackage.convert(meteorInstall, ...otherPackageFolders);
}
