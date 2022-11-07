import path from 'path';
import vm from 'vm';
import fs from 'fs-extra';
import fsPromises from 'fs/promises';
import semver from 'semver';
import rimraf from 'rimraf';
import util from 'util';
import AsyncLock from 'async-lock';

import {
  meteorNameToNodeName,
  meteorNameToNodePackageDir,
  nodeNameToMeteorName,
} from '../helpers/helpers.js';

import { ParentArchs, ExcludePackageNames } from '../constants.js';
import { getPackageGlobals, replaceGlobalsInFile, globalStaticImports } from '../helpers/globals.js';
import packageJsContext from '../helpers/package-js-context.js';
import { getExportStr, getExportMainModuleStr } from '../helpers/content.js';
import MeteorArch from './meteor-arch.js';
import { warn, error as logError } from '../helpers/log.js';
import { listFilesInDir } from '../commands/helpers/command-helpers.js';

// TODO: the problem with this is some packages tests might require conflicting versions of packages they otherwise don't care about
// e.g., our version of redis-oplog's tests require reywood:publish-composite@1.5.2 but our local version of publish-composite is 1.4.2
// this would create a version conflict where none would have existed before.
// I think when we're trying to convert a package and it's tests, we should run the command explicitly - potentially modifying an existing converted package
const CONVERT_TEST_PACKAGES = false;

// TODO - we need a noop package, this isn't a good choice but it does work
const NOOP_PACKAGE_NAME = '-';

const writingSymbol = Symbol('writing');

const supportedISOPackBuilds = new Map([
  ['client', 'client'], // see comment about brower/legacy/client in loadFromISOPack
  ['web.browser', 'web.browser'],
  ['web.browser.legacy', 'web.browser.legacy'],
  ['web.cordova', 'web.cordova'],
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

function getImportStr(importsSet, isCommon, job) {
  if (isCommon) {
    return sortImports(Array.from(importsSet)).map((imp) => {
      const suffix = job.get(nodeNameToMeteorName(imp))?.isLazy() ? '/__defineOnly.js' : '';
      return `require("${imp}${suffix}");`;
    }).join('\n');
  }

  return sortImports(Array.from(importsSet)).map((imp) => {
    const suffix = job.get(nodeNameToMeteorName(imp))?.isLazy() ? '/__defineOnly.js' : '';
    return `import "${imp}${suffix}";`;
  }).join('\n');
}

const meteorVersionPlaceholderSymbol = Symbol('meteor-version-placeholder');

export default class MeteorPackage {
  static Types = {
    SHARED: Symbol('SHARED'),
    LOCAL: Symbol('LOCAL'),
    ISO: Symbol('ISO'),
    OTHER: Symbol('OTHER'),
  };

  #folderName;

  #meteorName;

  #nodeName;

  #version;

  #versionConstraint;

  #description;

  #testPackage;

  #filePrefix = '';

  #startedWritingTest = false;

  #weakDependencies = new Set();

  #meteorDependencies = {};

  #dependencies = {};

  #peerDependencies = {};

  #optionalDependencies = {};

  #archs = new Map();

  #lock = new AsyncLock();

  #cancelled = false;

  #strongDependencies = new Set();

  #dependedOn = new Map();

  // non weak, non unordered
  #immediateDependencies = new Set();

  #imports = {};

  #isLazy = false;

  #waitingWrite = [];

  #isoResourcesToCopy = new Map();

  #folderPath;

  #type = MeteorPackage.Types.OTHER;

  #loadedPromise;

  #loadedResolve;

  #exportCondition;

  #writtenPromise;

  #alreadyWritten;

  #writtenResolve;

  #isTest;

  #hasTests;

  isFullyLoaded;

  #job;

  #filesToWatch = [];

  constructor({
    meteorName,
    versionConstraint,
    isTest,
    job,
  }) {
    this.#meteorName = meteorName;
    this.#versionConstraint = versionConstraint ? `^${versionConstraint}` : versionConstraint;
    this.#writtenPromise = new Promise((resolve) => {
      this.#writtenResolve = resolve;
    });
    this.#loadedPromise = new Promise((resolve) => {
      this.#loadedResolve = resolve;
    });
    this.#job = job;
    this.#isTest = !!isTest;
    if (!isTest) {
      this.#testPackage = new MeteorPackage({
        meteorName: '',
        versionConstraint,
        isTest: true,
        job,
      });
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

  allowRebuild() {
    this.#alreadyWritten = false;
  }

  async cancelAndDelete(outputParentFolder) {
    this.#cancelled = true;
    await this.#lock.acquire(
      writingSymbol,
      () => util.promisify(rimraf)(path.join(outputParentFolder, meteorNameToNodePackageDir(this.#meteorName))),
    );
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

  async loaded() {
    return this.#loadedPromise;
  }

  outputParentFolder(outputDirectories) {
    return outputDirectories[this.#type] || outputDirectories[MeteorPackage.Types.OTHER];
  }

  // TODO: remove if possible
  get type() {
    return this.#type;
  }

  isLocalOrShared() {
    return [MeteorPackage.Types.LOCAL, MeteorPackage.Types.SHARED].includes(this.#type);
  }

  filesToWatch() {
    if (!this.isLocalOrShared()) {
      return [];
    }
    return this.#filesToWatch;
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

  get meteorName() {
    return this.#meteorName;
  }

  get version() {
    return this.#version;
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
      // TODO: we probably need to export test only stuff too...somehow
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

  addDependendedOn(meteorPackage) {
    this.#dependedOn.set(meteorPackage.meteorName, meteorPackage);
  }

  addMeteorDependencies(packages, archNames, opts) {
    if (opts?.testOnly) {
      this.#hasTests = true;
      this.#testPackage.addMeteorDependencies(packages, archNames);
      return;
    }
    let deps = this.#meteorDependencies;
    if (opts?.unordered) {
      deps = this.#peerDependencies;
    }
    else if (opts?.weak) {
      deps = this.#optionalDependencies;
    }
    const actualArchs = this.getArchs(archNames);
    packages.forEach((dep) => {
      const [name, maybeVersionConstraint] = dep.split('@');
      if (ExcludePackageNames.has(name)) {
        return;
      }
      const nodeName = MeteorPackage.meteorNameToNodeName(name);

      if (opts?.weak) {
        actualArchs.forEach((arch) => arch.addPreloadPackage(nodeName));
        this.#weakDependencies.add(dep);
      }
      else {
        this.#strongDependencies.add(dep);
      }
      if (opts?.unordered) {
        actualArchs.forEach((arch) => arch.addUnorderedPackage(nodeName));
      }

      // TODO: actually use the version specifier if it exists
      deps[nodeName] = maybeVersionConstraint
        ? maybeVersionConstraint.split(/\s*\|\|\s*/).map((constraint) => `^${constraint}`).join(' || ')
        : meteorVersionPlaceholderSymbol;
      if (!opts?.unordered && !opts?.testOnly && !opts?.weak) {
        // TODO check comment in tools/isobuild/package-api.js
        this.addImport(nodeName, archNames);
        // TODO: do we actually need this.
        this.#immediateDependencies.add(dep);
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
      this.#strongDependencies.add(dep);
      const nodeName = MeteorPackage.meteorNameToNodeName(name);

      // TODO: we should probably NEVER use version, since we can't do resolution the way we want (at least until all versions are published to npm)
      this.#meteorDependencies[nodeName] = meteorVersionPlaceholderSymbol;
      this.#immediateDependencies.add(dep);
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
  getDependency(meteorNameAndMaybeVersionConstraint) {
    const [meteorName] = meteorNameAndMaybeVersionConstraint.split('@');
    return this.#job.get(meteorName);
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
      version: this.#version && semver.coerce(this.#version).version,
      description: this.#description,
      type: this.isCommon() ? 'commonjs' : 'module',
      dependencies: this.rewriteDependencies(this.#dependencies),

      devDependencies: CONVERT_TEST_PACKAGES ? this.rewriteDependencies({
        ...this.#testPackage.#dependencies,
        ...this.#testPackage.#meteorDependencies,
      }) : {},
      peerDependencies: this.rewriteDependencies({
        ...this.#peerDependencies,
        ...this.#meteorDependencies,
      }),
      optionalDependencies: this.rewriteDependencies(this.#optionalDependencies),
      exports: {
        ...(this.#hasTests ? {
          './__test.js': this.#testPackage.getExportsForPackageJSON(),
        } : {}),
        '.': this.getExportsForPackageJSON(),
        './*': './*',
      },
      imports: this.#imports,
      meteor: {
        assets: {
          ...(Object.fromEntries(this.getAllArchs().map((arch) => [
            arch.archName,
            arch.getAssets(true),
          ]).filter(([, values]) => values.length))),
        },
      },
      meteorTmp: {
        ...(this.#isLazy && { lazy: true }),
        // the combination of all weak dependencies of this package
        // AND all the ESM dependencies of this package if it is CJS
        // this is required since right now require(esm) just exports
        // the pre-defined package.
        preload: this.archsToObject((arch) => arch.getPreloadPackages(true)),
        // TODO: do the weakDependencies need to be present, even if we haven't converted them?
        // Probably yes, will have to handle this after we handle version control
        weakDependencies: Object.fromEntries(Array.from(this.#weakDependencies).map((packageNameAndMaybeVersionConstraint) => (this.getDependency(packageNameAndMaybeVersionConstraint) ? [
          meteorNameToNodeName(packageNameAndMaybeVersionConstraint.split('@')[0]), this.getDependency(packageNameAndMaybeVersionConstraint).#version,
        ] : undefined)).filter(Boolean)),
        unordered: this.archsToObject((arch) => arch.getUnorderedPackages(true)),
        dependencies: Object.fromEntries(Array.from(this.#strongDependencies).map((packageNameAndMaybeVersionConstraint) => [
          meteorNameToNodeName(packageNameAndMaybeVersionConstraint.split('@')[0]), this.getDependency(packageNameAndMaybeVersionConstraint).#version,
        ])),
        exportedVars,
        implies: this.archsToObject((arch) => arch.getImpliedPackages(true)),
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
    Object.keys(this.#meteorDependencies)
      .forEach((dep) => {
        const packageName = MeteorPackage.nodeNameToMeteorName(dep);
        const meteorPackage = this.getDependency(packageName);
        if (!meteorPackage) {
          warn(`couldn't recurse into ${packageName} from ${this.#meteorName}`);
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

  async rewriteDependants(outputParentFolderMapping) {
    console.log('rewriting', this.#meteorName);
    try {
      return Promise.all(Array.from(this.#dependedOn.values()).map((meteorPackage) => meteorPackage.writeDependencies(outputParentFolderMapping)));
    }
    finally {
      console.log('finished rewriting', this.#meteorName);
    }
  }

  async writeDependencies(outputParentFolderMapping) {
    await this.#loadedPromise;
    if (this.#alreadyWritten) {
      return true;
    }
    this.#alreadyWritten = true;
    await Promise.all(Array.from(this.#immediateDependencies).map(async (p) => {
      const dep = this.getDependency(p);
      if (!dep && !this.#weakDependencies.has(p)) {
        throw new Error(`Strong dependency ${p} missing for package ${this.#meteorName}`);
      }
      if (!dep || !dep.isFullyLoaded) {
        return;
      }
      await dep.writeToNpmModule(outputParentFolderMapping);
    }));
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
              getImportStr(arch.getImports(), this.isCommon(), this.#job),
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

  async writeToNpmModule(outputParentFolderMapping) {
    return this.#lock.acquire(writingSymbol, () => this.#writeToNpmModule(outputParentFolderMapping));
  }

  // a mapping of [MeteorPackage.Type]: absoluteOutputDirectory
  async #writeToNpmModule(outputParentFolderMapping) {
    if (this.#cancelled) {
      return;
    }

    const outputParentFolder = this.outputParentFolder(outputParentFolderMapping);
    // TODO: rework this entire function
    let state = 0;
    try {
      const shortCircuit = await this.writeDependencies(outputParentFolderMapping);
      if (shortCircuit) {
        return;
      }
      if (CONVERT_TEST_PACKAGES && this.#hasTests && !this.#startedWritingTest) {
        this.#startedWritingTest = true;
        try {
          await this.#testPackage.writeDependencies(outputParentFolderMapping);
        }
        catch (e) {
          e.message = `Test package problem: ${e.message}`;
          warn(e);
        }
      }
      state = 1;
      const outputFolder = path.resolve(`${outputParentFolder}/${meteorNameToNodePackageDir(this.#meteorName)}`);
      if (this.#type === MeteorPackage.Types.ISO) {
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
        this.#filesToWatch = await listFilesInDir(actualPath);
      }
      state = 2;
      const { archsForFiles, exportedMap } = await this.getImportTreeForPackageAndClean(outputFolder);
      this.getArchs().forEach((arch) => {
        const mainModule = arch.getMainModule();
        if (mainModule) {
          const absoluteMainModule = path.join(outputFolder, mainModule);
          if (exportedMap.has(absoluteMainModule)) {
            this.addExports(
              exportedMap.get(absoluteMainModule),
              arch.name,
            );
          }
        }
      });
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
          logError(`esm module ${this.#meteorName} using exports or require, this probably wont work`);
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
      logError(this.#meteorName, outputParentFolder, state);
      logError(error);
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

  async #loadISOBuild(json, archName) {
    json.uses.forEach(({
      package: packageName,
      weak,
      unordered,
      constraint,
    }) => {
      this.addMeteorDependencies([constraint ? `${packageName}@${constraint}` : packageName], [archName], { weak, unordered });
    });
    json.implies?.forEach(({
      package: packageName,
      constraint,
      weak,
    }) => {
      this.addImplies([constraint ? `${packageName}@${constraint}` : packageName], [archName], { weak });
    });
    json.resources.forEach(({
      path: aPath,
      file,
      type,
      servePath,
      fileOptions: {
        lazy,
        mainModule,
      } = {},
    }) => {
      let actualPath = aPath;
      // prelink is from isopack-1, e.g. meteorhacks:zones
      if (!actualPath && type === 'prelink') {
        actualPath = servePath;
      }
      if (!actualPath && type !== 'source') {
        // iron:dynamic-template has a compiled version of dynamic_template.html I think
        // this needs to be imported as normal, but it doesn't have a "path"
        actualPath = servePath.split('/').slice(3).join('/');
      }
      if ((type === 'source' || type === 'prelink') && actualPath.startsWith('/packages/')) {
        // TODO: because archName is mapped from os -> server, this won't work for server files - edgecase
        actualPath = actualPath.replace('/packages/', `/${archName}/`);
      }
      if (mainModule) {
        this.setMainModule(`./${actualPath}`, [archName], { lazy });
      }
      else if (!lazy) {
        this.addImport(`./${actualPath}`, [archName]);
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
          actualPath = actualPath.replace('/packages/', `/${archName}/`);
        }
        this.addImport(`./${actualPath}`, [archName]);
      });

    json.resources
      .filter(({ type }) => type === 'asset')
      .forEach(({ path: aPath }) => {
        this.addAssets([aPath], [archName]);
      });
    if (json.declaredExports) {
      json.declaredExports.forEach(({ name, testOnly }) => {
        if (!testOnly) {
          this.addExports([name], [archName]);
        }
      });
    }
  }

  async loadFromISOPack(fullFolder) {
    this.isFullyLoaded = true;
    this.#type = MeteorPackage.Types.ISO;
    this.#folderPath = fullFolder;
    const fullISOPack = JSON.parse((await fsPromises.readFile(path.join(fullFolder, 'isopack.json'))).toString());
    const isopack = fullISOPack['isopack-2'] || fullISOPack['isopack-1'];
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
      Array.from(this.#strongDependencies).map((packageNameAndMaybeVersionConstraint) => this.#job.ensurePackage(
        packageNameAndMaybeVersionConstraint,
      )),
    )).filter(Boolean);
    this.#loadedResolve();
    await this.ensurePackages();
    // this.#alreadyWritten = true;
  }

  async ensurePackages() {
    // first make sure all impled or used packages are loaded
    this.#waitingWrite = (await Promise.all([
      ...Array.from(this.#strongDependencies).map(async (packageNameAndMaybeVersionConstraint) => {
        try {
          return await this.#job.ensurePackage(
            packageNameAndMaybeVersionConstraint,
          );
        }
        catch (e) {
          e.message = `Couldn't ensure ${packageNameAndMaybeVersionConstraint} of ${this.#meteorName}  because ${e.message}`;
          throw e;
        }
      }),
      ...Array.from(this.#weakDependencies).map(async (packageNameAndMaybeVersionConstraint) => {
        try {
          return await this.#job.ensurePackage(
            packageNameAndMaybeVersionConstraint,
          );
        }
        catch (e) {
          e.message = `Couldn't ensure weak dependency ${packageNameAndMaybeVersionConstraint} of ${this.#meteorName} because ${e.message}`;
          warn(e.message);
          return false;
        }
      }),
    ])).filter(Boolean);

    // now we've loaded all our dependencies, time to make sure all our ESM modules (if we're CJS) are listed as preload
    if (this.isCommon()) {
      this.#strongDependencies.forEach((packageNameAndMaybeVersionConstraint) => {
        const [packageName] = packageNameAndMaybeVersionConstraint.split('@');
        const requiredPackage = this.getDependency(packageNameAndMaybeVersionConstraint);
        requiredPackage.addDependendedOn(this);
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

  async loadFromNodeJSON(packageJSON) {
    try {
      this.isFullyLoaded = true;
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
        this.#strongDependencies.add(version ? `${meteorName}@${version}` : meteorName);
      });
      this.#loadedResolve();
      this.#alreadyWritten = true;

      await this.ensurePackages();
      return true;
    }
    catch (e) {
      return false;
    }
  }

  async loadFromMeteorPackage(meteorInstall, packageJsPath, packageType) {
    try {
      this.isFullyLoaded = true;
      this.#type = packageType;
      this.#folderPath = path.dirname(packageJsPath);
      const script = new vm.Script((await fsPromises.readFile(packageJsPath)).toString());
      const context = packageJsContext(this, meteorInstall);
      try {
        script.runInNewContext(context);
        // because meteor expects the callbacks to be sync, and we need to async pull in versions from the meteor DB
        // we just set a promise with the callback and await it here
        await Promise.all([
          context.onUsePromise,
          context.onTestPromise,
        ]);
        await this.ensurePackages();
        if (CONVERT_TEST_PACKAGES && this.#hasTests) {
          try {
            await this.#testPackage.ensurePackages();
          }
          catch (e) {
            e.message = `Test package problem: ${e.message}`;
            warn(e);
          }
        }
      }
      catch (e) {
        e.message = `problem parsing ${this.#meteorName}: ${e.message}`;
        throw e;
      }
      // next, find all the direct dependencies and see what they imply. Then add those to our dependencies
      Object.keys(this.#meteorDependencies)
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
      error.message = `${this.#meteorName || this.#folderName}: ${error.message}`;

      // TODO: remove - need to figure out a way of removing a package when it fails (probably from job.ensurePackage)
      this.#job.delete(this.#meteorName);
      throw error;
    }
    finally {
      this.#loadedResolve();
      this.#testPackage.#loadedResolve();
    }
  }

  rewriteDependencies(dependencies) {
    return Object.fromEntries(Object.entries(dependencies).map(([name, version]) => {
      if (version === meteorVersionPlaceholderSymbol) {
        const importedPackage = this.#job.get(MeteorPackage.nodeNameToMeteorName(name));
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
}
