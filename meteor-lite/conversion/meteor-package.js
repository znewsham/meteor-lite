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
  meteorVersionToSemver,
  nodeNameToMeteorName,
} from '../helpers/helpers.js';

import { ParentArchs, ExcludePackageNames } from '../constants.js';
import { getPackageGlobals, replaceGlobalsInFile, globalStaticImports } from './globals.js';
import packageJsContext from './package-js-context.js';
import { getExportStr, getExportMainModuleStr } from './content.js';
import MeteorArch from './meteor-arch.js';
import { warn, error as logError } from '../helpers/log.js';
import listFilesInDir from '../helpers/list-files';

// we need a "noop" package for when we have an import/export that should only be available to specific archs
const NOOP_PACKAGE_NAME = '@meteor/noop';

const SERVER_ASSETS_FILE = [
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
].join('\n');

const writingSymbol = Symbol('writing');

const supportedISOPackBuilds = new Map([
  ['client', 'client'], // see comment about brower/legacy/client in loadFromISOPack
  ['web.browser', 'web.browser'],
  ['web.browser.legacy', 'web.browser.legacy'],
  ['web.cordova', 'web.cordova'],
  ['os', 'server'],
]);

const ClientOnlyExtensions = [
  '.html',
  '.less',
  '.css',
];

const DefaultArchs = ['client', 'server'];

// Package names can only contain lowercase ASCII alphanumerics, dash, dot, or colon
export const TestSuffix = '--test--';

const DefaultClientArchs = ['client'];

const CommonJSPackageNames = new Set([
  'jquery',
  'underscore',
  'softwarerero:accounts-t9n',
  'ecmascript-runtime-client',
  'package-version-parser',
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

function getImportStr(importsSet, isCommon) {
  if (isCommon) {
    return sortImports(Array.from(importsSet)).map((imp) => `require("${imp}");`).join('\n');
  }

  return sortImports(Array.from(importsSet)).map((imp) => `import "${imp}";`).join('\n');
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

  #meteorDependencies = {};

  #dependencies = {};

  #peerDependencies = {};

  #optionalDependencies = {};

  #archs = new Map();

  #lock = new AsyncLock();

  #cancelled = false;

  #dependedOn = new Map();

  #uses = [];

  #implies = [];

  // weak dependencies
  #weakDependencies = new Set();

  // non weak, non unordered dependencies
  #strongDependencies = new Set();

  // (non weak and non unordered) or implied dependencies
  #dependenciesToEnsure = new Set();

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

  isFullyLoaded; // TODO: this is poorly named - I forget what it was for originally, it is now used to short circuit things but doesnt *actually* fully loaded

  #shouldBeWritten;

  #job;

  #filesToWatch = [];

  #exportedGlobals;

  #convertTestPackage = false;

  #importOrder = 0;

  constructor({
    meteorName,
    versionConstraint,
    isTest,
    convertTestPackage = false,
    job,
  }) {
    this.#meteorName = meteorName;
    this.#versionConstraint = versionConstraint && meteorVersionToSemver(versionConstraint);
    this.#writtenPromise = new Promise((resolve) => {
      this.#writtenResolve = resolve;
    });
    this.#loadedPromise = new Promise((resolve) => {
      this.#loadedResolve = resolve;
    });
    this.#convertTestPackage = convertTestPackage;
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

  isLocalOrShared() {
    return [MeteorPackage.Types.LOCAL, MeteorPackage.Types.SHARED].includes(this.#type);
  }

  filesToWatch() {
    return this.#filesToWatch;
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
      return CommonJSPackageNames.has(this.#meteorName.replace(TestSuffix, ''));
    }
    return CommonJSPackageNames.has(this.#meteorName);
  }

  // TODO: remove if possible
  get type() {
    return this.#type;
  }

  get folderName() {
    return this.#meteorName.replace(':', '_');
  }

  get meteorName() {
    return this.#meteorName;
  }

  get versionConstraint() {
    return this.#versionConstraint;
  }

  get version() {
    return this.#version;
  }

  get testVersionRecord() {
    return {
      ...this.#testPackage?.versionRecord,
      version: this.version,
    };
  }

  get versionRecord() {
    return {
      version: this.version,
      dependencies: Object.fromEntries(this.#uses.map(({ name, constraint, archs, weak }) => [
        name,
        {
          constraint,
          references: (archs || ['client', 'server'])
            .map((clientOrServer) => {
              if (clientOrServer === 'server') {
                return 'os';
              }
              if (clientOrServer === 'web.browser') {
                return 'web.browser';
              }
              return clientOrServer;
            })
            .map((archName) => ({ arch: archName, weak })),
        },
      ])),
    };
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
    this.#testPackage.#meteorName = `${this.#meteorName}${TestSuffix}`;

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
    symbols.forEach((symbol) => {
      actualArchs.forEach((arch) => {
        arch.addExport(symbol);
      });
    });
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
    const importOrder = this.#importOrder;
    this.#importOrder += 1;
    let resolvedArchNames = archNames;
    // hack for old packages (iron:*) that add html files to the server by omitting the archs arg.
    if (!resolvedArchNames && ClientOnlyExtensions.find((ext) => item.endsWith(ext))) {
      resolvedArchNames = DefaultClientArchs;
    }
    const actualArchs = this.getArchs(resolvedArchNames);
    actualArchs.forEach((arch) => {
      arch.addImport(item, importOrder);
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
      deps = undefined;
    }
    const actualArchs = this.getArchs(archNames);
    packages.forEach((dep) => {
      const [name, maybeVersionConstraint] = dep.split('@');
      if (ExcludePackageNames.has(name)) {
        return;
      }
      this.#uses.push({
        name,
        ...(maybeVersionConstraint && { constraint: maybeVersionConstraint }),
        ...(archNames?.length && { archs: archNames }),
        ...(opts || {}),
      });
      const nodeName = MeteorPackage.meteorNameToNodeName(name);

      if (!opts?.weak && !opts?.unordered) {
        this.#dependenciesToEnsure.add(dep);
      }
      if (opts?.weak) {
        actualArchs.forEach((arch) => arch.addPreloadPackage(nodeName));
        this.#weakDependencies.add(dep);
      }
      else if (!opts?.unordered) {
        this.#strongDependencies.add(dep);
      }
      if (opts?.unordered) {
        actualArchs.forEach((arch) => arch.addUnorderedPackage(nodeName));
      }

      // TODO: actually use the version specifier if it exists
      if (!opts?.weak) {
        deps[nodeName] = maybeVersionConstraint
          ? maybeVersionConstraint.split(/\s*\|\|\s*/).map((constraint) => meteorVersionToSemver(constraint)).join(' || ')
          : meteorVersionPlaceholderSymbol;
      }
      if (!opts?.unordered && !opts?.testOnly && !opts?.weak) {
        this.addImport(nodeName, archNames);
      }
    });
  }

  addImplies(packages, archNames) {
    const actualArchs = this.getArchs(archNames);

    // implied pacakges are unordered (e.g., they load *after* the package itself)
    this.addMeteorDependencies(packages, archNames, { unordered: true });
    packages.forEach((dep) => {
      const [meteorName, maybeConstraint] = dep.split('@');
      if (ExcludePackageNames.has(meteorName)) {
        return;
      }

      // even though implied packages are unordered, they are still immediate dependencies of this package,
      // they aren't circular dependencies
      this.#dependenciesToEnsure.add(dep);
      actualArchs.forEach((arch) => {
        arch.addImpliedPackage(meteorName);
      });
      this.#implies.push({
        name: meteorName,
        constraint: maybeConstraint,
        archs: archNames,
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
      ...(Object.fromEntries(this.getLeafArchs().map((arch) => {
        const fileWithoutSiffix = `./${this.#filePrefix}__${arch.getActiveArch().archName}`;
        return [
          arch.getExportArchName(),
          {
            import: `${fileWithoutSiffix}.js`,
            require: !this.isCommon() ? `${fileWithoutSiffix}.cjs` : `${fileWithoutSiffix}.js`,
          },
        ];
      }))),
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
      dependencies: this.#rewriteDependencies(this.#dependencies),

      devDependencies: this.#convertTestPackage ? this.#rewriteDependencies({
        ...this.#testPackage.#dependencies,
        ...this.#testPackage.#meteorDependencies,
      }) : {},
      peerDependencies: this.#rewriteDependencies({
        ...this.#peerDependencies,
        ...this.#meteorDependencies,
      }),
      optionalDependencies: this.#rewriteDependencies(this.#optionalDependencies),
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
        exportedVars,
        ...(this.#convertTestPackage && this.#hasTests ? {
          testUses: this.#testPackage.#uses.map(({ name, constraint, ...rest }) => ({
            name: meteorNameToNodeName(name),
            constraint: constraint || this.getDependency(name)?.constraint,
            ...rest,
          })),
        } : {}),
        uses: this.#uses.map(({ name, constraint, ...rest }) => ({
          name: meteorNameToNodeName(name),
          constraint: constraint || this.getDependency(name)?.constraint,
          ...rest,
        })),
        implies: this.#implies.map(({ name, constraint, ...rest }) => ({
          name: meteorNameToNodeName(name),
          constraint: constraint || this.getDependency(name)?.constraint,
          ...rest,
        })),
      },
    };
  }

  // TODO: if forceRefresh really "works" - almost certainly I've misunderstood how vars are re-exported from packages and this can be cleaned up
  // critically, this fails because we only wait for our immediate dependencies to be loaded before calling this function
  #calculateExportedGlobals(forceRefresh = false) {
    const archNames = this.getLeafArchs().map((arch) => arch.archName);
    if (this.#exportedGlobals && !forceRefresh) {
      return this.#exportedGlobals;
    }
    this.#exportedGlobals = Object.fromEntries(archNames.map((archName) => [
      archName,
      new Map(),
    ]));

    Object.keys(this.#meteorDependencies)
      .forEach((dep) => {
        const packageName = MeteorPackage.nodeNameToMeteorName(dep);
        const meteorPackage = this.getDependency(packageName);
        if (!meteorPackage) {
          warn(`couldn't recurse into ${packageName} from ${this.#meteorName}`);
          return;
        }
        const depGlobals = meteorPackage.#calculateExportedGlobals();
        Object.entries(depGlobals).forEach(([archName, archGlobals]) => {
          if (!this.#exportedGlobals[archName]) {
            return;
          }
          archGlobals.forEach((providingDep, exp) => {
            this.#exportedGlobals[archName].set(exp, providingDep);
          });
        });
        archNames.forEach((archName) => {
          meteorPackage.getImplies(archName)
            .forEach((impPackageName) => {
              const imp = meteorNameToNodeName(impPackageName);
              const impliedPackage = this.getDependency(impPackageName);
              impliedPackage.getExportedVars(archName)
                .forEach((exp) => {
                  this.#exportedGlobals[archName].set(exp, imp);
                });
            });
          meteorPackage.getExportedVars(archName)
            .forEach((exp) => {
              this.#exportedGlobals[archName].set(exp, dep);
            });
        });
      });
    return this.#exportedGlobals;
  }

  getImportedGlobalsMaps(globals) {
    const archNames = this.getLeafArchs().map((arch) => arch.archName);
    const ret = Object.fromEntries(archNames.map((archName) => [
      archName,
      new Map(),
    ]));
    const cached = this.#calculateExportedGlobals(true);
    globals.forEach((global) => {
      if (globalStaticImports.has(global) && globalStaticImports.get(global) !== this.#nodeName) {
        archNames.forEach((archName) => {
          ret[archName].set(global, globalStaticImports.get(global));
        });
      }
      archNames.forEach((archName) => {
        if (cached[archName].has(global)) {
          ret[archName].set(global, cached[archName].get(global));
        }
      });
    });
    return ret;
  }

  getDependenciesToEnsure() {
    return this.#dependenciesToEnsure;
  }

  getImplies(archName) {
    return this.getArch(archName)?.getImpliedPackages() || new Set();
  }

  getExportedVars(archName) {
    if (!archName) {
      return Array.from(new Set(this.getAllArchs().flatMap((arch) => arch.getExports())));
    }
    return this.getArch(archName).getExports();
  }

  async rewriteDependants(outputParentFolderMapping) {
    return Promise.all(Array.from(this.#dependedOn.values()).map((meteorPackage) => meteorPackage.#writeDependencies(outputParentFolderMapping)));
  }

  async #writeDependencies(outputParentFolderMapping) {
    await this.#loadedPromise;
    await Promise.all(Array.from(this.#dependenciesToEnsure).map((p) => {
      const dep = this.getDependency(p);
      if (!dep) {
        return undefined;
      }
      return dep.#loadedPromise;
    }));
    if (this.#alreadyWritten) {
      return true;
    }
    this.#alreadyWritten = true;
    await Promise.all(Array.from(this.#dependenciesToEnsure).map(async (p) => {
      const dep = this.getDependency(p);
      if (!dep || !dep.isFullyLoaded || !dep.#shouldBeWritten || dep.#alreadyWritten) {
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

  async #writeEntryPoints(outputFolder) {
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

  async writeToNpmModule(outputParentFolderMapping, convertTests) {
    return this.#lock.acquire(writingSymbol, () => this.#writeToNpmModule(outputParentFolderMapping, convertTests));
  }

  // a mapping of [MeteorPackage.Type]: absoluteOutputDirectory
  async #writeToNpmModule(outputParentFolderMapping, convertTests) {
    if (this.#cancelled) {
      return;
    }
    const outputParentFolder = this.outputParentFolder(outputParentFolderMapping);
    // TODO: rework this entire function
    try {
      const shortCircuit = await this.#writeDependencies(outputParentFolderMapping);
      // this must be after the writeDependencies to ensure that any missing dependencies are written out correctly (edge casey)
      if (!convertTests && (shortCircuit || !this.#shouldBeWritten)) {
        return;
      }
      if (convertTests && this.#convertTestPackage && this.#hasTests && !this.#startedWritingTest) {
        this.#startedWritingTest = true;
        try {
          await this.#testPackage.#writeDependencies(outputParentFolderMapping);
        }
        catch (e) {
          e.message = `Test package problem: ${e.message}`;
          warn(e);
        }
      }
      const outputFolder = path.resolve(`${outputParentFolder}/${meteorNameToNodePackageDir(this.#meteorName)}`);
      if (this.#type === MeteorPackage.Types.ISO) {
        await this.#copyISOPackResources(outputFolder);
      }
      else {
        const actualPath = await fs.realpath(this.#folderPath);

        await fs.copy(
          actualPath,
          outputFolder,
          {
            filter(src) {
              return !src.includes('.npm') && !src.includes('package.json');
            },
          },
        );
        this.#filesToWatch = (await listFilesInDir(actualPath)).filter((fileName) => !fileName.includes('/.npm/'));
      }
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
      // this should go away, but is needed for the exports/require/module hack below
      // this probably isn't 'correct' - since it doesn't really consider per-arch "bad package globals"
      const badPackageGlobals = Array.from(allGlobals)
        .filter((global) => !Object.values(importedGlobalsByArch).find((archMap) => archMap.has(global)));
      let badTestPackageGlobals = [];
      let testPackageGlobals = [];

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
      if (serverOnlyImportsSet.size) {
        this.addMeteorDependencies([nodeNameToMeteorName(NOOP_PACKAGE_NAME)], ['server']);
      }
      serverOnlyImportsSet.forEach((serverOnlyImport) => {
        this.#imports[`#${serverOnlyImport}`] = {
          node: serverOnlyImport,
          default: NOOP_PACKAGE_NAME,
        };
      });
      if (this.#convertTestPackage && this.#hasTests) {
        // puke - this entire chunk.
        const { archsForFiles: testArchsForFiles } = await this.#testPackage.getImportTreeForPackageAndClean(outputFolder);
        Array.from(testArchsForFiles.keys()).forEach((key) => {
          if (archsForFiles.has(key)) {
            testArchsForFiles.delete(key);
          }
        });
        const { all: testGlobalsByFile, assigned: packageTestGlobalsByFile } = await getPackageGlobals(
          this.isCommon(),
          outputFolder,
          testArchsForFiles,
        );
        const packageTestGlobals = new Set(Array.from(packageTestGlobalsByFile.values()).flatMap((v) => Array.from(v)));
        const testServerOnlyImportsSet = new Set();
        const allTestGlobals = new Set(Array.from(testGlobalsByFile.values()).flatMap((v) => Array.from(v)));
        testPackageGlobals = new Set(Array.from(packageTestGlobalsByFile.values()).flatMap((v) => Array.from(v)));
        const importedTestGlobalsByArch = this.#testPackage.getImportedGlobalsMaps(allTestGlobals);
        badTestPackageGlobals = Array.from(allTestGlobals)
          .filter((global) => !Object.values(importedTestGlobalsByArch).find((archMap) => archMap.has(global)));
        await Promise.all(Array.from(testGlobalsByFile.entries()).map(([file, globals]) => replaceGlobalsInFile(
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
        await this.#testPackage.#writeEntryPoints(outputFolder);
      }
      if (badTestPackageGlobals.length || badPackageGlobals.length || this.getExportedVars().length) {
        const exportNamesSet = new Set([
          ...this.getExportedVars(),
          ...badPackageGlobals,
          ...badTestPackageGlobals,
          ...testPackageGlobals,
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
          this.addMeteorDependencies([nodeNameToMeteorName(NOOP_PACKAGE_NAME)], ['server']);
          this.#imports['#assets'] = {
            node: `./${this.#filePrefix}__server_assets.js`,
            default: NOOP_PACKAGE_NAME,
          };
          await fs.writeFile(
            `${outputFolder}/${this.#filePrefix}__server_assets.js`,
            SERVER_ASSETS_FILE,
          );
        }
        if ((hasRequire && !hasExports) && this.getArch('server')?.getMainModule()) {
          warn(`esm module ${this.#meteorName} using require, this might not work`);
        }
        if ((hasExports) && this.getArch('server')?.getMainModule()) {
          logError(`esm module ${this.#meteorName} using exports (and maybe require too), this probably wont work`);
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
      await Promise.all([
        fsPromises.writeFile(
          `${outputFolder}/package.json`,
          JSON.stringify(this.toJSON(), null, 2),
        ),
        this.#writeEntryPoints(outputFolder),
      ]);
    }
    catch (error) {
      logError(this.#meteorName, outputParentFolder);
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
        // NOTE: because archName is mapped from os -> server, this won't work for server files - edgecase
        actualPath = actualPath.replace('/packages/', `/${archName}/`);
      }
      if (mainModule) {
        this.setMainModule(`./${actualPath}`, [archName], { lazy });
      }
      else if ((type === 'source' || type === 'prelink') && !lazy) {
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
      json.declaredExports.forEach(({ name }) => {
        // NOTE: this means we "leak" test only exports in prod. I'm totally fine with this
        // we can't disable entirely since a tiny handful of packages provide test only exports
        // since (it would appear, e.g., OplogHandle) that meteor treats any package global as an export, this is ok
        this.addExports([name], [archName]);
      });
    }
  }

  get folderPath() {
    return this.folderPath;
  }

  async readFromISOPack(fullFolder) {
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
  }

  async loadFromISOPack(fullFolder) {
    this.isFullyLoaded = true;
    this.#shouldBeWritten = true;
    await this.readFromISOPack(fullFolder);

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
      ...Array.from(this.#dependenciesToEnsure).map(async (packageNameAndMaybeVersionConstraint) => {
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
          // NOTE: this is pretty noisy, and probably not useful warn(e.message);
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
        packageJSON.meteorTmp.implies.forEach(({ name: nodeName, archs }) => {
          this.addImplies([nodeNameToMeteorName(nodeName)], archs);
        });
      }
      if (!packageJSON.meteorTmp?.uses) {
        warn(`${packageJSON.name} doesn't have a meteorTmp.uses`);
        return false;
      }
      packageJSON.meteorTmp.uses.forEach(({ name: nodeName, constraint, unordered, weak }) => {
        if (!unordered && !weak) {
          const meteorName = nodeNameToMeteorName(nodeName);
          this.#strongDependencies.add(constraint ? `${meteorName}@${constraint}` : meteorName);
          this.#dependenciesToEnsure.add(meteorName);
        }
      });
      this.#loadedResolve();
      // this.#alreadyWritten = true;

      await this.ensurePackages();
      return true;
    }
    catch (e) {
      return false;
    }
  }

  async readDependenciesFromPacakgeJS(packageJsPath, packageType) {
    this.#type = packageType;
    this.#folderPath = path.dirname(packageJsPath);
    const script = new vm.Script((await fsPromises.readFile(packageJsPath)).toString());
    const context = packageJsContext(this);
    try {
      script.runInNewContext(context);
      // because meteor expects the callbacks to be sync, and we need to async pull in versions from the meteor DB
      // we just set a promise with the callback and await it here
      await Promise.all([
        context.onUsePromise,
        context.onTestPromise,
      ]);
    }
    catch (e) {
      e.message = `problem parsing ${this.#meteorName}: ${e.message}`;
      throw e;
    }
  }

  async loadFromMeteorPackage(packageJsPath, packageType) {
    try {
      await this.readDependenciesFromPacakgeJS(packageJsPath, packageType);
      await this.ensurePackages();
      if (this.#convertTestPackage && this.#hasTests) {
        try {
          await this.#testPackage.ensurePackages();
        }
        catch (e) {
          e.message = `Test package problem: ${e.message}`;
          warn(e);
        }
      }
      this.isFullyLoaded = true;
      this.#shouldBeWritten = true;
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
            impliedSet.forEach((meteorName) => this.addImport(meteorNameToNodeName(meteorName), [arch.archName]));
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

  #rewriteDependencies(dependencies) {
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
