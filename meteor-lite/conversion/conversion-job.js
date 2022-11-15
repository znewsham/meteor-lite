import path from 'path';
import semver from 'semver';
import fsPromises from 'fs/promises';
import fs from 'fs-extra';
import pacote from 'pacote';
import { ExcludePackageNames } from '../constants';
import {
  meteorNameToNodeName,
  meteorNameToNodePackageDir,
  sortSemver,
  versionsAreCompatible,
  meteorVersionToSemver,
} from '../helpers/helpers';
import { warn, error as logError } from '../helpers/log';
import MeteorPackage, { TestSuffix } from './meteor-package';
import { getNpmRc, registryForPackage } from '../helpers/ensure-npm-rc';
import AsyncLock from 'async-lock';
import ensureLocalPackage from '../helpers/ensure-local-package';
import Catalog from './catalog';

export default class ConversionJob {
  #outputGeneralDirectory;

  #outputSharedDirectory;

  #outputLocalDirectory;

  #localFolder;

  #sharedFolder;

  #otherPackageFolders;

  #allPackageFolders;

  #meteorInstall;

  #forceRefreshOptions;

  #skipNonLocalIfPossible;

  #packageMap = new Map();

  #packageNameToFolderPaths = new Map();

  #localPackageNameToFolderPaths = new Map();

  #npmrc;

  #constraintSolver;

  #packageVersionParser;

  #lock = new AsyncLock({ maxPending: Number.MAX_SAFE_INTEGER });

  #testPackages;

  // when converting the initial set of packages, we don't have the packages necessary to perform version checking
  #checkVersions;

  constructor({
    outputGeneralDirectory,
    outputSharedDirectory,
    outputLocalDirectory,
    meteorInstall,
    otherPackageFolders,
    forceRefresh,
    skipNonLocalIfPossible = true,
    checkVesions = false,
  }) {
    this.#outputGeneralDirectory = path.resolve(outputGeneralDirectory);
    this.#outputSharedDirectory = path.resolve(outputSharedDirectory || outputGeneralDirectory);
    this.#outputLocalDirectory = path.resolve(outputLocalDirectory || outputGeneralDirectory);
    this.#localFolder = path.resolve('packages');
    this.#sharedFolder = process.env.METEOR_PACKAGE_DIRS && path.resolve(process.env.METEOR_PACKAGE_DIRS);
    this.#otherPackageFolders = otherPackageFolders.map((folderName) => path.resolve(folderName));
    this.#allPackageFolders = [
      this.#localFolder,
      this.#sharedFolder,
      ...this.#otherPackageFolders,
    ].filter(Boolean);
    this.#meteorInstall = meteorInstall;
    this.#forceRefreshOptions = forceRefresh;
    this.#skipNonLocalIfPossible = skipNonLocalIfPossible;
    this.#checkVersions = checkVesions;
  }

  #outputDirectories() {
    return {
      [MeteorPackage.Types.ISO]: this.#outputGeneralDirectory,
      [MeteorPackage.Types.OTHER]: this.#outputGeneralDirectory,
      [MeteorPackage.Types.LOCAL]: this.#outputLocalDirectory,
      [MeteorPackage.Types.SHARED]: this.#outputSharedDirectory,
    };
  }

  async reconvert(meteorPackage) {
    meteorPackage.isFullyLoaded = false;
    meteorPackage.allowRebuild();
    await this.loadPackage(meteorPackage, meteorPackage.version);
    await meteorPackage.writeToNpmModule(this.#outputDirectories());
    return true;
  }

  async #createCatalog() {
    await import('@meteor/modern-browsers');
    this.#constraintSolver = await import('@meteor/constraint-solver');
    this.#packageVersionParser = (await import('@meteor/package-version-parser')).default;
    await this.#populatePackageNameToFolderPaths(
      this.#allPackageFolders,
      this.#packageNameToFolderPaths,
    );

    const localPackageMap = new Map();
    await Promise.all(Array.from(this.#packageNameToFolderPaths.entries()).map(async ([meteorName, packageJsPathObject]) => {
      let actualMeteorName = meteorName;
      let isTest = false;
      if (meteorName.endsWith(TestSuffix)) {
        isTest = true;
        actualMeteorName = meteorName.replace(TestSuffix);
      }
      const meteorPackage = new MeteorPackage({
        meteorName: actualMeteorName,
        isTest: false,
        job: this,
        convertTestPackage: isTest,
      });
      try {
        await meteorPackage.readDependenciesFromPacakgeJS(
          packageJsPathObject.packageJsPath,
          packageJsPathObject.type,
        );
      }
      catch (e) {
        warn(e.message);
      }

      localPackageMap.set(meteorName, {
        versionRecord: meteorPackage.versionRecord,
        testVersionRecord: meteorPackage.testVersionRecord,
      });
    }));

    const catalog = new Catalog(this.#meteorInstall, localPackageMap);
    await catalog.init();
    return catalog;
  }

  async convertPackages(meteorNames, meteorNamesAndVersions) {
    let versionResult;
    if (this.#checkVersions) {
      const catalog = await this.#createCatalog();
      const ps = new this.#constraintSolver.ConstraintSolver.PackagesResolver(catalog);
      versionResult = ps.resolve(
        meteorNames.map((nv) => nv.split('@')[0]),
        meteorNamesAndVersions.map((nv) => new this.#packageVersionParser.PackageConstraint(nv)),
      );
      // NOTE: this is a shitty way of passing in test package names,
      // but it's hard to unwind - specifically for the constraint solving
      // we need to know which packages we're testing so we can load the test dependencies (which will include the package)
      // I think in the future we can just do a second pass on every package - but it's not obvious how to get around the above
      // not every package will provide test dependencies, and if we just give a static list to the constraint solver of "all these are test packages"
      // we'll end up with a circular reference between a package and itself (e.g., everytime you see X load X-test and X-test depends on X)
      this.#testPackages = new Set(meteorNames
        .filter((meteorName) => meteorName.endsWith(TestSuffix))
        .map((meteorName) => meteorName.replace(TestSuffix, '')));

      Object.entries(versionResult.answer).forEach(([meteorName, version]) => {
        this.warmPackage(`${meteorName}@${version}`);
      });
    }
    else {
      this.#testPackages = new Set();
      meteorNames.forEach((meteorName) => this.warmPackage(meteorName));
    }
    const cleanNames = meteorNames
      .map((meteorName) => {
        const ensuredVersion = versionResult && versionResult.answer[meteorName];
        const actualMeteorName = meteorName.endsWith(TestSuffix) ? meteorName.replace(TestSuffix, '') : meteorName;
        if (ensuredVersion) {
          return `${actualMeteorName}@${ensuredVersion}`;
        }
        return actualMeteorName;
      });

    // a special package that does nothing. Useful for optional imports/exports
    cleanNames.push('noop@0.0.1');

    // first convert all the non-test packages so we know they're done, then we do all the test packages.
    // this should help with circular dependencies (a little)
    await Promise.all(cleanNames.map(async (nameAndMaybeVersion) => this.#convertPackage(nameAndMaybeVersion)));
    const testNames = cleanNames
      .filter((meteorNameAndVersion) => this.#testPackages.has(meteorNameAndVersion.split('@')[0]));

    const testPackageDependencies = Array.from(
      new Set(
        testNames.flatMap((nameAndVersion) => Object.keys(this.get(nameAndVersion).testVersionRecord.dependencies)),
      ),
    );
    await Promise.all(testPackageDependencies.map((async (meteorNameAndVersion) => this.#convertPackage(meteorNameAndVersion))));
    await Promise.all(testNames
      .map(async (meteorNameAndVersion) => this.#convertPackage(meteorNameAndVersion, true)));
  }

  async #convertPackage(meteorNameAndMaybeVersionConstraint, convertTests = false) {
    const [meteorName, maybeVersionConstraint] = meteorNameAndMaybeVersionConstraint.split('@');
    const meteorPackage = this.warmPackage(meteorNameAndMaybeVersionConstraint) || (convertTests && this.#packageMap.get(meteorName));
    if (!meteorPackage) { // the package was already converted
      return false;
    }
    meteorPackage.isFullyLoaded = true;
    if (this.#skipNonLocalIfPossible) {
      const packageJsPathObject = await this.#findPackageJs(meteorPackage.meteorName, true);
      if (!packageJsPathObject) {
        const isGood = await this.convertFromExistingIfPossible(meteorPackage, meteorPackage.type);
        if (isGood) {
          return false;
        }
      }
    }
    await this.loadPackage(meteorPackage, maybeVersionConstraint);
    await meteorPackage.writeToNpmModule(this.#outputDirectories(), convertTests);
    return true;
  }

  warmPackage(meteorNameAndMaybeVersionConstraint) {
    const [meteorName, maybeVersionConstraint] = meteorNameAndMaybeVersionConstraint.split('@');
    if (ExcludePackageNames.has(meteorName)) {
      return undefined;
    }
    if (this.#packageMap.has(meteorName) && this.#packageMap.get(meteorName).isFullyLoaded) {
      return undefined;
    }
    const isTest = this.#testPackages.has(meteorName);
    const meteorPackage = new MeteorPackage({
      meteorName,
      versionConstraint: maybeVersionConstraint,
      isTest: false,
      job: this,
      convertTestPackage: isTest,
    });
    this.#packageMap.set(meteorName, meteorPackage);
    return meteorPackage;
  }

  async convertFromExistingIfPossible(meteorPackage, type) {
    if (this.#forceRefresh(meteorPackage.meteorName)) {
      return false;
    }
    // TODO: version control? What if we've moved a package?
    const alreadyConvertedJson = await this.#alreadyConvertedJson(
      meteorPackage.meteorName,
      meteorPackage.version || meteorPackage.versionConstraint,
      this.#outputDirectories()[type],
    );
    if (alreadyConvertedJson) {
      const isGood = await meteorPackage.loadFromNodeJSON(alreadyConvertedJson);
      // even though this is already converted, we need to trigger this write to ensure any missing dependencies are written (edge casey)
      await meteorPackage.writeToNpmModule(this.#outputDirectories(), false);
      return isGood;
    }
    return false;
  }

  async #ensureRegistryConfig() {
    if (!this.#npmrc) {
      this.#npmrc = await getNpmRc();
    }
  }

  async #checkRegistryForConvertedPackage(meteorName, maybeVersionConstraint) {
    const nodeName = meteorNameToNodeName(meteorName);
    await this.#ensureRegistryConfig();
    const registry = await registryForPackage(nodeName, this.#npmrc);
    if (registry) {
      // TODO: we should probably "always" do this in the future.
      // For now it'll only happen if we've explicitly pushed, which will always be to a custom registry
      try {
        const packageSpec = maybeVersionConstraint ? `${nodeName}@${meteorVersionToSemver(maybeVersionConstraint)}` : nodeName;
        const options = {
          fullReadJson: true,
          fullMetadata: true,
          where: process.cwd(),
          registry,
        };
        return await pacote.manifest(packageSpec, options);
      }
      catch (e) {
        return false;
      }
    }
    return false;
  }

  async #alreadyConvertedPath(meteorName) {
    const packagePath = meteorNameToNodePackageDir(meteorName);


    // TODO: path mapping
    const actualPath = path.join(this.#outputGeneralDirectory, packagePath, 'package.json');
    if (await fs.pathExists(actualPath)) {
      return actualPath;
    }
    return false;
  }

  async #alreadyConvertedJson(meteorName, maybeVersionConstraint) {
    const actualPath = await this.#alreadyConvertedPath(meteorName);
    if (actualPath) {
      const ret = JSON.parse((await fsPromises.readFile(actualPath)).toString());
      if (!maybeVersionConstraint || versionsAreCompatible(ret.version, maybeVersionConstraint)) {
        return ret;
      }
    }
    return this.#checkRegistryForConvertedPackage(meteorName, maybeVersionConstraint);
  }

  async #populatePackageNameToFolderPaths(paths, map) {
    const folders = paths;
    const tempPrioMap = new Map();

    // allFolders = { folder, type } - where type is either packages, shared or other
    const allFolders = (await Promise.all(folders.map(async (folder) => {
      if (!await fs.pathExists(folder)) {
        return [];
      }
      const innerFolders = await fsPromises.readdir(folder, { withFileTypes: true });
      let type = MeteorPackage.Types.OTHER;
      if (folder === this.#localFolder) {
        type = MeteorPackage.Types.LOCAL;
      }
      else if (folder === this.#sharedFolder) {
        type = MeteorPackage.Types.SHARED;
      }
      return innerFolders
        .filter((innerFolder) => innerFolder.isDirectory)
        .map((innerFolder) => ({ type, folder: path.join(folder, innerFolder.name) }));
    }))).flat();

    await Promise.all(allFolders.map(async ({ folder, type }, index) => {
      const packageJsPath = path.join(folder, 'package.js');
      if (!await fs.pathExists(packageJsPath)) {
        return;
      }
      const packageJs = (await fs.readFile(packageJsPath)).toString();
      const hasName = packageJs.match(/Package\.describe\(\{[^}]+['"]?name['"]?\s*:\s*['"]([a-zA-Z0-9:-]+)["']/);
      const actualName = hasName ? hasName[1] : folder.split('/').slice(-1)[0];
      if (!tempPrioMap.has(actualName) || tempPrioMap.get(actualName) > index) {
        tempPrioMap.set(actualName, index);
        map.set(actualName, { packageJsPath, type });
      }
    }));
  }

  async #findPackageJs(name, localOnly) {
    const map = localOnly ? this.#localPackageNameToFolderPaths : this.#packageNameToFolderPaths;
    if (!localOnly && !map.size) {
      await this.#lock.acquire('initPackageJsMap', async () => {
        await this.#populatePackageNameToFolderPaths(
          this.#allPackageFolders,
          this.#packageNameToFolderPaths,
        );
      });
    }
    if (localOnly && !map.size) {
      await this.#lock.acquire('initPackageJsMap', async () => {
        await this.#populatePackageNameToFolderPaths(
          [this.#localFolder, this.#sharedFolder].filter(Boolean),
          this.#localPackageNameToFolderPaths,
        );
      });
    }
    return map.get(name);
  }

  async #pathToISOPack(meteorName, versionConstraint) {
    const folderName = (meteorName).split(':').join('_');
    if (!await fs.pathExists(this.#meteorInstall)) {
      throw new Error('Meteor not installed');
    }

    await ensureLocalPackage({
      meteorInstall: this.#meteorInstall,
      name: meteorName,
      versionConstraint,
    });

    const basePath = path.join(this.#meteorInstall, 'packages', folderName);
    // this shouldn't be possible anymore thanks to ensureLocalPackage
    if (!await fs.pathExists(basePath)) {
      throw new Error(`${meteorName} Package not installed by meteor`);
    }
    const origNames = (await fsPromises.readdir(basePath)).filter((name) => !name.startsWith('.'));
    let names = origNames;
    if (versionConstraint) {
      names = names.filter((name) => versionsAreCompatible(name, versionConstraint));
      names = sortSemver(names);
    }
    if (!names.length) {
      throw new Error(`No matching version in ${origNames} satisfies ${versionConstraint}`);
    }
    return path.join(basePath, names.slice(-1)[0]);
  }

  async loadPackage(meteorPackage, versionConstraint) {
    const packageJsPathObject = await this.#findPackageJs(meteorPackage.meteorName, false);
    if (packageJsPathObject) {
      await meteorPackage.loadFromMeteorPackage(
        packageJsPathObject.packageJsPath,
        packageJsPathObject.type,
      );
    }
    else {
      const pathToISOPackFolder = await this.#pathToISOPack(meteorPackage.meteorName, versionConstraint);
      await meteorPackage.loadFromISOPack(pathToISOPackFolder);
    }
  }

  #forceRefresh(meteorName) {
    if (!this.#forceRefreshOptions) {
      return false;
    }
    if (this.#forceRefreshOptions === true) {
      return true;
    }
    if (this.#forceRefreshOptions instanceof Set) {
      return this.#forceRefreshOptions.has(meteorName);
    }
    return true;
  }

  async ensurePackage(meteorNameAndMaybeVersionConstraint) {
    const [meteorName, maybeVersionConstraint] = meteorNameAndMaybeVersionConstraint.split('@');
    const versionToSatisfy = maybeVersionConstraint
      ? meteorVersionToSemver(maybeVersionConstraint)
      : undefined;

    let meteorPackage = this.#packageMap.get(meteorName);
    if (!meteorPackage && this.#checkVersions) {
      throw new Error(`tried to load unresolved package ${meteorName}`);
    }
    else if (!meteorPackage) {
      meteorPackage = this.warmPackage(meteorNameAndMaybeVersionConstraint);
    }
    if (maybeVersionConstraint && meteorPackage?.isFullyLoaded) {
      if (!meteorPackage.version) {
        await meteorPackage.loaded();
      }
      if (!versionsAreCompatible(meteorPackage.version, versionToSatisfy)) {
        throw new Error(`version mismatch for ${meteorName}. ${versionToSatisfy} requested but ${meteorPackage.version} loaded`);
      }
    }
    if (!this.#packageMap.get(meteorName)?.isFullyLoaded) {
      meteorPackage.isFullyLoaded = true; // TODO: this probably shouldn't be here, but we need to make sure it happens before any other await
      if (!this.#forceRefresh(meteorName)) {
        // if the package exists in a "local" dir, we're gonna convert it even if it's already converted
        const shouldSkip = !await this.#findPackageJs(meteorName, true);
        if (shouldSkip) {
          // if we don't want to greedily convert this package, look for an existing JSON (either in an npm registry or locally)
          // if we find it, and the conversion is good, we're good. Otherwise, continue to load.
          const alreadyConvertedJson = await this.#alreadyConvertedJson(
            meteorName,
            maybeVersionConstraint || meteorPackage.versionConstraint,
          );
          if (alreadyConvertedJson) {
            const isGood = await meteorPackage.loadFromNodeJSON(alreadyConvertedJson);
            if (isGood) {
              // even though this is already converted, we need to trigger this write to ensure any missing dependencies are written (edge casey)
              await meteorPackage.writeToNpmModule(this.#outputDirectories(), false);
              return false;
            }
          }
        }
      }
      await this.loadPackage(meteorPackage, maybeVersionConstraint || meteorPackage.versionConstraint);
      return meteorPackage;
    }

    // if we aren't building a package, return false
    return false;
  }

  has(meteorNameAndMaybeVersionConstraint) {
    const [name] = meteorNameAndMaybeVersionConstraint.split('@');
    return this.#packageMap.has(name);
  }

  get(meteorNameAndMaybeVersionConstraint) {
    const [name] = meteorNameAndMaybeVersionConstraint.split('@');
    return this.#packageMap.get(name);
  }

  getAll() {
    return Array.from(this.#packageMap.values());
  }

  getAllLocal() {
    return Array.from(this.#packageMap.values()).filter((meteorPackage) => meteorPackage.isLocalOrShared());
  }

  // TODO: remove
  delete(meteorNameAndMaybeVersionConstraint) {
    const [name] = meteorNameAndMaybeVersionConstraint.split('@');
    return this.#packageMap.delete(name);
  }

  convertedPackageNames() {
    return this.#packageMap.keys();
  }
}
