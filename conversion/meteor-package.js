import path from 'path';
import vm from 'vm';
import fs, { ensureDir } from 'fs-extra';
import fsPromises from 'fs/promises';
import semver from 'semver';
import rimraf from 'rimraf';
import util from 'util';
import AsyncLock from 'async-lock';
import { walk } from 'estree-walker';
import { dirSync } from 'tmp';

import {
  meteorNameToNodeName,
  meteorNameToNodePackageDir,
  meteorVersionToSemver,
  nodeNameToMeteorName,
} from '../helpers/helpers.js';

import { ParentArchs, ExcludePackageNames } from '../constants.js';
import { getPackageGlobals, replaceGlobalsInFile, globalStaticImports } from './globals.js';
import replaceImportsInAst from './ast/rewrite/replace-imports';
import packageJsContext from './package-js-context.js';
import { getExportStr, getExportMainModuleStr } from './content.js';
import MeteorArch from './meteor-arch.js';
import { warn, error as logError } from '../helpers/log.js';
import listFilesInDir from '../helpers/list-files';
import { astToCode } from './ast/index.js';

const rimrafAsync = util.promisify(rimraf);

// we need a "noop" package for when we have an import/export that should only be available to specific archs
const NOOP_PACKAGE_NAME = '@meteor/noop';

// we're no longer going to inject asset code into a package at runtime - instead we'll make it part of a package.
const ASSETS_PACKAGE_NAME = '@meteor/assets';

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

// TODO: modern actually maps to web.browser and server, legacy maps to web.browser.legacy and web.cordova
// it's not super trivial to implement this (getArch and all places it uses will now potentially return an array)
const SynonymArchs = new Map([
  ['legacy', 'web.browser.legacy'],
  ['modern', 'web.browser'],
]);

// these are the ultimate leaf architectures we support - there is no such thing as a "client" build.
export const LeafArchs = [
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
    NODE: Symbol('NODE'), // loaded from a node package - doesn't need to be written or converted
  };

  #typescriptDefinitionFile;

  #folderName;

  #meteorName;

  #nodeName;

  #version;

  #versionConstraint;

  #description;

  /**
   * @type MeteorPackage
   */
  #testPackage;

  #filePrefix = '';

  #meteorDependencies = {};

  #dependencies = {};

  #peerDependencies = {};

  #optionalDependencies = {};

  #archs = new Map();

  #lock = new AsyncLock();

  #asts = new Map();

  // actually fully loaded everything we can (including ASTs) without loading all dependencies
  #fullyLoadedWithoutDeps = false;

  #fullyLoadedWithDeps = false;

  #defaultExportsForMainModules = new Map();

  #finalOutput = new Map();

  #globalsByFile;

  #packageGlobalsByFile;

  #archsForFiles = new Map();

  #loadedExports = new Map();

  #astsLoaded = false;

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

  #isFullyLoaded; // TODO: this is poorly named - I forget what it was for originally, it is now used to short circuit things but doesnt *actually* fully loaded

  #shouldBeWritten;

  #job;

  #filesToWatch = [];

  #exportedGlobals;

  #exports = new Map();

  #importOrder = 0;

  #onlyRequiredByTest;

  constructor({
    meteorName,
    versionConstraint,
    isTest,
    onlyRequiredByTest,
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
    // under no circumstances should this be used. Currently it will (when building for production) load weak dependencies incorrectly
    // this problem isn't resolvable - I've left this in place to remind the next person of that.
    this.#onlyRequiredByTest = false; // !!onlyRequiredByTest;
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
    this.#isFullyLoaded = false;
    this.#alreadyWritten = false;
    this.#cleanupReadyForNextEnsureAndWrite();
  }

  async cancelAndDelete(outputParentFolder) {
    this.#cancelled = true;
    await this.#lock.acquire(
      writingSymbol,
      () => rimrafAsync(path.join(outputParentFolder, meteorNameToNodePackageDir(this.#meteorName))),
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
          this.#meteorName,
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

  // TODO: remove this - it shouldn't be needed
  set isFullyLoaded(isFullyLoaded) {
    this.#isFullyLoaded = isFullyLoaded;
  }

  get isFullyLoaded() {
    return this.#isFullyLoaded;
  }

  get onlyRequiredByTest() {
    return this.#onlyRequiredByTest;
  }

  setRequiredByNonTest() {
    this.#onlyRequiredByTest = true;
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
      dependencies: Object.fromEntries(this.#uses.map(({
        name,
        constraint,
        archs,
        weak,
      }) => [
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
    debugOnly,
  }) {
    this.#meteorName = name || this.#meteorName;
    this.#nodeName = MeteorPackage.meteorNameToNodeName(name || this.#meteorName);
    this.#description = description;

    // semver doesn't support _
    this.#version = version.replace('_', '-');
    this.#testPackage.#meteorName = `${this.#meteorName}${TestSuffix}`;

    if ([prodOnly, devOnly, debugOnly, testOnly].filter(Boolean).length > 1) {
      throw new Error('Package can\'t be any combination of prod, dev or test only');
    }

    if (prodOnly) {
      this.#exportCondition = 'production';
    }
    if (testOnly) {
      this.#exportCondition = 'test';
    }
    if (devOnly || debugOnly) {
      this.#exportCondition = 'development';
    }
  }

  addExports(symbols, archNames, opts) {
    const actualArchs = this.getArchs(archNames);
    symbols.forEach((symbol) => {
      if (!this.#exports.has(symbol)) {
        this.#exports.set(symbol, {
          archs: new Set(),
          opts,
        });
      }
      actualArchs.forEach((arch) => {
        this.#exports.get(symbol).archs.add(arch);
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
      if (file.endsWith('.d.ts')) {
        this.#typescriptDefinitionFile = file;
      }
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

  /**
   *
   * @param {String} meteorNameAndMaybeVersionConstraint
   * @returns MeteorPackage
   */
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
    const exportedVars = Array.from(this.#exports.entries()).map(([symbol, { archs, opts }]) => ({
      name: symbol,
      archs: Array.from(archs).map((arch) => arch.archName), // trying to be consistent with uses which is consistent with ISOPack
      ...opts, // contains testOnly, debugOnly, prodOnly
    }));
    return {
      name: this.#nodeName,
      version: this.#version && semver.coerce(this.#version).version,
      description: this.#description,
      type: this.isCommon() ? 'commonjs' : 'module',
      ...(this.#typescriptDefinitionFile && { types: `./${this.#typescriptDefinitionFile}` }),
      dependencies: this.#rewriteDependencies(this.#dependencies),

      devDependencies: this.#rewriteDependencies({
        ...this.#testPackage.#dependencies,
        ...this.#testPackage.#meteorDependencies,
      }),
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
        ...(this.#hasTests ? {
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

  async #loadImportTreeForPackageAndClean() {
    await Promise.all(this.getActiveLeafArchs().map((arch) => arch.getImportTreeForPackageAndClean(
      this.#folderPath,
      this.#archsForFiles,
      this.isCommon(),
      this.#loadedExports,
      this.#asts,
    )));
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
        try {
          return Promise.all([
            fsPromises.writeFile(
              `${outputFolder}/${this.#filePrefix}__${arch.archName}.js`,
              [
                getImportStr(arch.getImports(), this.isCommon()),
                ...(arch.getMainModule()
                  ? [await getExportMainModuleStr(
                    this.#meteorName,
                    arch.getMainModule(),
                    this.isCommon(),
                    this.#defaultExportsForMainModules.get(arch.getMainModule()),
                  )]
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
        }
        catch (e) {
          console.log(this.#meteorName, arch.getMainModule());
          throw e;
        }
      }),
      this.#exportCondition ? fsPromises.writeFile(`${outputFolder}/__noop.js`, 'export {};') : undefined,
    ]);
  }

  async writeToNpmModule(outputParentFolderMapping, convertTests) {
    return this.#lock.acquire(writingSymbol, () => this.#writeToNpmModule(outputParentFolderMapping, convertTests));
  }

  async #setupOutputFolder(outputFolder) {
    if (this.#type === MeteorPackage.Types.ISO) {
      await this.#copyISOPackResources(outputFolder);
    }
    else {
      const actualPath = await fs.realpath(this.#folderPath);

      await fs.copy(
        actualPath,
        outputFolder,
        {
          filter: (src, dest) => {
            const relative = dest.replace(outputFolder, '.');
            if (this.#asts.has(relative)) {
              return false;
            }
            return !src.includes('.npm') && !src.includes('package.json');
          },
        },
      );
      this.#filesToWatch = (await listFilesInDir(actualPath)).filter((fileName) => !fileName.includes('/.npm/'));
    }
  }

  async #writeConvertedFiles(outputFolder) {
    return Promise.all(Array.from(this.#globalsByFile.keys()).map((file) => {
      const fullPath = path.join(outputFolder, file);
      return fsPromises.writeFile(
        fullPath,
        this.#finalOutput.get(file),
      );
    }));
  }

  #getExportNameSet(convertTests) {
    const allGlobals = new Set(Array.from(this.#globalsByFile.values()).flatMap((v) => Array.from(v)));
    const importedGlobalsByArch = this.getImportedGlobalsMaps(allGlobals);
    // these are all the globals USED in the package. Not just those assigned.
    // this should go away, but is needed for the exports/require/module hack below
    // this probably isn't 'correct' - since it doesn't really consider per-arch "bad package globals"
    const badPackageGlobals = Array.from(allGlobals)
      .filter((global) => !Object.values(importedGlobalsByArch).find((archMap) => archMap.has(global)));
    const packageGlobals = new Set(Array.from(this.#packageGlobalsByFile.values()).flatMap((v) => Array.from(v)));
    return new Set([
      ...this.getExportedVars(),
      ...badPackageGlobals,
      ...packageGlobals,
      ...(convertTests && this.#hasTests && this.#testPackage) ? this.#testPackage.#getExportNameSet() : [],
    ]);
  }

  // can't be async because writing package.json depends on it - but it does return an array of promises
  #writeGlobalsAndModules(outputFolder, convertTests) {
    const promises = [];
    const exportNamesSet = this.#getExportNameSet(convertTests);

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
      this.addMeteorDependencies([nodeNameToMeteorName(ASSETS_PACKAGE_NAME)], ['server']);
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
      promises.push(...[
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
      promises.push(fsPromises.writeFile(
        `${outputFolder}/__globals.js`,
        Array.from(exportNamesSet).sort().map((name) => `module.exports.${name} = undefined;`).join('\n'),
      ));
    }
    else {
      promises.push(fsPromises.writeFile(
        `${outputFolder}/__globals.js`,
        [
          ...(hasNpm || hasRequire ? ['import module from "#module";'] : []),
          ...hasAssets ? [`import { createAssets } from '${ASSETS_PACKAGE_NAME}'`] : [],
          'export default {',
          ...(exportNamesSet.size ? [`  ${Array.from(exportNamesSet).sort().map((name) => `${name}: undefined`).join(',\n  ')},`] : []),
          ...(hasNpm ? ['  Npm: { require: module.createRequire(import.meta.url) },'] : []),
          ...(hasModule ? ['  module: { id: import.meta.url },'] : []),
          ...(hasRequire ? ['  require: module.createRequire(import.meta.url),'] : []),
          ...(hasAssets ? ['   Assets: createAssets(import.meta.url),'] : []),
          '}',
        ].join('\n'),
      ));
    }
    return promises;
  }

  // a mapping of [MeteorPackage.Type]: absoluteOutputDirectory
  async #writeToNpmModule(outputParentFolderMapping, convertTests) {
    if (this.#cancelled || !this.#shouldBeWritten || this.#alreadyWritten) {
      return;
    }
    this.#alreadyWritten = true;
    const outputParentFolder = this.outputParentFolder(outputParentFolderMapping);
    // TODO: rework this entire function
    try {
      const promises = [];
      const outputFolder = path.resolve(`${outputParentFolder}/${meteorNameToNodePackageDir(this.#meteorName)}`);

      await this.#setupOutputFolder(outputFolder);
      // here we're writing out all the files
      promises.push(this.#writeConvertedFiles(outputFolder));
      promises.push(this.#writeEntryPoints(outputFolder));

      if (convertTests && this.#hasTests) {
        promises.push(this.#testPackage.#writeConvertedFiles(outputFolder));
        promises.push(this.#testPackage.#writeEntryPoints(outputFolder));
      }
      promises.push(...this.#writeGlobalsAndModules(outputFolder, convertTests));
      promises.push(fsPromises.writeFile(
        `${outputFolder}/package.json`,
        JSON.stringify(this.toJSON(), null, 2),
      ));
      await Promise.all(promises);
    }
    catch (error) {
      logError(this.#meteorName, outputParentFolder);
      logError(error);
      throw error;
    }
    finally {
      this.#writtenResolve();
      this.#cleanupReadyForNextEnsureAndWrite();
    }
  }

  async #copyISOPackResources(outputFolder) {
    await fs.ensureDir(outputFolder);
    return Promise.all(Array.from(this.#isoResourcesToCopy.entries()).map(async ([dest, src]) => {
      await fs.ensureDir(path.dirname(path.join(outputFolder, dest)));
      return fsPromises.copyFile(path.join(this.#folderPath, src), path.join(outputFolder, dest));
    }));
  }

  async #loadISOBuild(json, archName, tmpDirName) {
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

    // HACK - if the build has no web.browser.legacy we use client as the build name, but that path wont exist
    const archToReplaceWith = archName;
    const promises = [];
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
        actualPath = actualPath.replace('/packages/', `/${archToReplaceWith}/`);
      }
      if (mainModule) {
        this.setMainModule(`./${actualPath}`, [archName], { lazy });
      }
      else if ((type === 'source' || type === 'prelink') && !lazy) {
        this.addImport(`./${actualPath}`, [archName]);
      }
      this.#isoResourcesToCopy.set(actualPath, actualPath);
      promises.push(
        ensureDir(path.join(tmpDirName, actualPath, '..'))
          .then(() => fsPromises.copyFile(
            path.join(this.#folderPath, file),
            path.join(tmpDirName, actualPath),
          )),
      );
    });
    await Promise.all(promises);
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
    return this.#folderPath;
  }

  setFolderPath(folderPath) {
    this.#folderPath = folderPath;
    this.#testPackage.#folderPath = folderPath;
  }

  async readFromISOPack(fullFolder) {
    this.#type = MeteorPackage.Types.ISO;
    this.setFolderPath(fullFolder);
    const fullISOPack = JSON.parse((await fsPromises.readFile(path.join(fullFolder, 'isopack.json'))).toString());
    const isopack = fullISOPack['isopack-2'] || fullISOPack['isopack-1'];
    this.setBasic({
      name: isopack.name,
      description: isopack.summary,
      version: isopack.version,
      prodOnly: isopack.prodOnly,
      devOnly: isopack.devOnly,
      debugOnly: isopack.debugOnly,
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
    const { name: tmpDirName } = dirSync({
      unsafeCleanup: true,
    });
    await Promise.all(builds.map(async (build) => {
      const buildJson = JSON.parse((await fsPromises.readFile(path.join(fullFolder, build.path))).toString());
      return this.#loadISOBuild(buildJson, supportedISOPackBuilds.get(build.arch), tmpDirName);
    }));
    this.#folderPath = tmpDirName;
  }

  async loadFromISOPack(fullFolder) {
    this.#isFullyLoaded = true;
    this.#shouldBeWritten = true;
    await this.readFromISOPack(fullFolder);
    await this.#ensureFullyLoadedWithoutDeps();

    // first make sure all impled or used packages are loaded
    this.#waitingWrite = (await Promise.all(
      Array.from(this.#strongDependencies).map((packageNameAndMaybeVersionConstraint) => this.#job.ensurePackage(
        packageNameAndMaybeVersionConstraint,
        { fromTest: this.#isTest || this.#onlyRequiredByTest },
      )),
    )).filter(Boolean);
    this.#loadedResolve();
    this.#testPackage.#loadedResolve();
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
            { fromTest: this.#isTest || this.#onlyRequiredByTest },
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
            { fromTest: this.#isTest, optional: true },
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
      this.#type = MeteorPackage.Types.NODE;
      this.#testPackage.#type = MeteorPackage.Types.NODE;
      this.#isFullyLoaded = true;
      this.setBasic({
        name: nodeNameToMeteorName(packageJSON.name),
        version: packageJSON.version,
        description: packageJSON.description,
      });

      if (packageJSON.meteorTmp?.exportedVars) {
        if (Array.isArray(packageJSON.meteorTmp.exportedVars)) {
          packageJSON.meteorTmp.exportedVars.forEach(({
            name,
            archs,
            ...opts // testOnly, debugOnly, prodOnly
          }) => {
            this.addExports([name], archs, opts);
          });
        }
        else {
          // deprecated
          Object.entries(packageJSON.meteorTmp.exportedVars).forEach(([arch, symbols]) => {
            this.addExports(symbols, [arch]);
          });
        }
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
      packageJSON.meteorTmp.uses.forEach(({
        name: nodeName,
        constraint,
        unordered,
        weak,
      }) => {
        if (!unordered && !weak) {
          const meteorName = nodeNameToMeteorName(nodeName);
          this.#strongDependencies.add(constraint ? `${meteorName}@${constraint}` : meteorName);
          this.#dependenciesToEnsure.add(meteorName);
        }
      });
      this.#loadedResolve();
      this.#testPackage.#loadedResolve();
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
    this.setFolderPath(path.dirname(packageJsPath));
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

  async #ensureASTs() {
    if (this.#astsLoaded) {
      return;
    }
    this.#astsLoaded = true;
    await this.#loadImportTreeForPackageAndClean();
  }

  async #ensureLoadedPackageGlobals() {
    if (this.#globalsByFile) {
      return;
    }
    const { all: globalsByFile, assigned: packageGlobalsByFile } = await getPackageGlobals(
      this.isCommon(),
      this.#archsForFiles,
      this.#asts,
    );
    this.#globalsByFile = globalsByFile;
    this.#packageGlobalsByFile = packageGlobalsByFile;
  }

  async #ensureLoadedExports() {
    this.getArchs().forEach((arch) => {
      const mainModule = arch.getMainModule();
      if (mainModule) {
        if (this.#loadedExports.has(mainModule)) {
          this.addExports(
            this.#loadedExports.get(mainModule),
            arch.name,
          );
        }
      }
    });
  }

  #ensureLoadedMainDefaultExport() {
    this.getAllArchs().forEach((arch) => {
      const mainModule = arch.getMainModule();
      if (!mainModule) {
        return;
      }
      const ast = this.#asts.get(mainModule);
      let hasDefault;
      walk(ast, {
        enter(node) {
          if (node.type === 'ExportDefaultDeclaration') {
            hasDefault = true;
          }
          else if (node.type === 'ExportSpecifier' && node.exported.name === 'default' && node.local.name === 'default') {
            hasDefault = true;
          }
        },
      });
      this.#defaultExportsForMainModules.set(mainModule, hasDefault);
    });
  }

  async #ensureFullyLoadedWithoutDeps() {
    if (this.#type === MeteorPackage.Types.NODE) {
      this.#fullyLoadedWithoutDeps = true;
    }
    if (this.#fullyLoadedWithoutDeps) {
      return;
    }
    await this.#lock.acquire('fullLoadWithoutDeps', async () => {
      if (this.#fullyLoadedWithoutDeps) {
        return;
      }
      await this.#ensureASTs();
      await this.#ensureLoadedPackageGlobals();
      this.#ensureLoadedExports();
      this.#ensureLoadedMainDefaultExport();
      if (this.#testPackage) {
        await this.#testPackage.#ensureFullyLoadedWithoutDeps();
        Array.from(this.#testPackage.#archsForFiles.keys()).forEach((key) => {
          if (this.#archsForFiles.has(key)) {
            this.#testPackage.#archsForFiles.delete(key);
          }
        });
        Array.from(this.#testPackage.#globalsByFile.keys()).forEach((key) => {
          if (this.#globalsByFile.has(key)) {
            this.#testPackage.#globalsByFile.delete(key);
          }
        });
      }
      this.#fullyLoadedWithoutDeps = true;
    });
  }

  #cleanupReadyForNextEnsureAndWrite() {
    this.#fullyLoadedWithoutDeps = false;
    this.#fullyLoadedWithDeps = false;
    this.#astsLoaded = false;
    this.#globalsByFile = undefined;
    this.#archsForFiles = new Map();
    this.#asts = new Map();
    this.#finalOutput = new Map();
    if (this.#testPackage) {
      this.#testPackage.#cleanupReadyForNextEnsureAndWrite();
    }
  }

  async #ensureAllDependenciesLoaded() {
    if (this.#fullyLoadedWithDeps) {
      return;
    }
    await this.#ensureFullyLoadedWithoutDeps();
    await this.#lock.acquire('fullLoadWithDeps', async () => {
      if (this.#fullyLoadedWithDeps) {
        return;
      }
      await Promise.all(Array.from(this.#dependenciesToEnsure).map(async (depName) => {
        const dep = this.getDependency(depName);
        return dep.#ensureAllDependenciesLoaded();
      }));
      await this.#loadedPromise;
      this.#fullyLoadedWithDeps = true;
    });
  }

  async ensurePackageFullyLoaded() {
    await this.#ensureAllDependenciesLoaded();
    await this.#replacePackageGlobals();
    await this.#ensureImpliedImportsAdded();
  }

  // this must be separate from ensureAllDependenciesLoaded because this is where the deadlock would occur
  async ensureTestPackageFullyLoaded() {
    return this.#testPackage.ensurePackageFullyLoaded();
  }

  async #replacePackageGlobals() {
    if (this.#type === MeteorPackage.Types.NODE) {
      return;
    }
    const serverOnlyImportsSet = new Set();
    const packageGlobals = new Set(Array.from(this.#packageGlobalsByFile.values()).flatMap((v) => Array.from(v)));
    const allGlobals = new Set(Array.from(this.#globalsByFile.values()).flatMap((v) => Array.from(v)));
    const importedGlobalsByArch = this.getImportedGlobalsMaps(allGlobals);
    await Promise.all(Array.from(this.#globalsByFile.entries()).map(async ([file, globals]) => {
      if (!this.#finalOutput.has(file)) {
        const ast = this.#asts.get(file);
        const archs = this.#archsForFiles.get(file);
        const isMultiArch = archs?.size > 1;
        replaceImportsInAst(ast, isMultiArch, serverOnlyImportsSet, file);
        const importStr = replaceGlobalsInFile(
          globals,
          file,
          importedGlobalsByArch,
          this.isCommon(),
          (name) => this.getDependency(name),
          archs,
          packageGlobals,
          ast,
        );
        const output = [
          importStr,
          astToCode(ast),
        ].filter(Boolean).join('\n');
        this.#finalOutput.set(file, output);
      }
    }));
    if (serverOnlyImportsSet.size) {
      this.addMeteorDependencies([nodeNameToMeteorName(NOOP_PACKAGE_NAME)], ['server']);
    }
    serverOnlyImportsSet.forEach((serverOnlyImport) => {
      this.#imports[`#${serverOnlyImport}`] = {
        node: serverOnlyImport,
        default: NOOP_PACKAGE_NAME,
      };
    });
  }

  async #ensureImpliedImportsAdded() {
    // next, find all the direct dependencies and see what they imply. Then add those to our dependencies
    Object.keys(this.#meteorDependencies)
      .forEach((dep) => {
        const importedPackage = this.getDependency(MeteorPackage.nodeNameToMeteorName(dep));
        if (!importedPackage) {
          // was't a meteor package...
          return;
        }
        // NOTE: this slightly odd expression handles the case where this package has a client leaf arch,
        // but the imported package has web.* leaf archs
        this.getActiveLeafArchs().forEach((arch) => {
          const impliedSet = new Set([
            ...importedPackage.getImplies(arch.archName),
            ...Array.from(
              Array.from(arch.getAllChildArchs())
                .map((childArch) => Array.from(importedPackage.getImplies(childArch.archName))),
            ).flat(),
          ]);
          impliedSet.forEach((meteorName) => this.addImport(meteorNameToNodeName(meteorName), [arch.archName]));
        });
      });
  }

  async loadFromMeteorPackage(packageJsPath, packageType, convertTests) {
    try {
      await this.readDependenciesFromPacakgeJS(packageJsPath, packageType);
      await this.ensurePackages();
      if (convertTests && this.#hasTests) {
        try {
          await this.#testPackage.ensurePackages();
        }
        catch (e) {
          this.#hasTests = false; // if we can't load the test package, we don't have tests.
          this.#testPackage.#fullyLoadedWithDeps = true;
          e.message = `Test package problem: ${e.message}`;
          warn(e);
        }
      }
      await this.#ensureFullyLoadedWithoutDeps();
      this.#isFullyLoaded = true;
      this.#shouldBeWritten = true;
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
