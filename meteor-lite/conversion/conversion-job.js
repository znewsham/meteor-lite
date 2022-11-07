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
import MeteorPackage from './meteor-package';
import { getNpmRc, registryForPackage } from '../helpers/ensure-npm-rc';
import ensureLocalPackage from '../helpers/ensure-local-package';

export default class ConversionJob {
  #outputGeneralDirectory;

  #outputSharedDirectory;

  #outputLocalDirectory;

  #localFolder;

  #sharedFolder;

  #otherPackageFolders;

  #allPackageFolders;

  #meteorInstall;

  #options;

  #packageMap = new Map();

  #packageNameToFolderPaths = new Map();

  #localPackageNameToFolderPaths = new Map();

  #npmrc;

  constructor({
    outputGeneralDirectory,
    outputSharedDirectory,
    outputLocalDirectory,
    meteorInstall,
    otherPackageFolders,
    options, // TODO: break this out
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
    this.#options = options;
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

  async convertPackage(meteorNameAndMaybeVersionConstraint) {
    const [, maybeVersionConstraint] = meteorNameAndMaybeVersionConstraint.split('@');
    const meteorPackage = this.warmPackage(meteorNameAndMaybeVersionConstraint);
    if (!meteorPackage) { // the package was already converted
      return false;
    }
    meteorPackage.isFullyLoaded = true; // TODO
    if (this.#options.skipNonLocalIfPossible) {
      const packageJsPathObject = await this.#findPackageJs(meteorPackage.meteorName, true);
      if (!packageJsPathObject) {
        const isGood = await this.convertFromExistingIfPossible(meteorPackage, meteorPackage.type);
        if (isGood) {
          return false;
        }
      }
    }
    await this.loadPackage(meteorPackage, maybeVersionConstraint);
    await meteorPackage.writeToNpmModule(this.#outputDirectories());
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
    const meteorPackage = new MeteorPackage({
      meteorName,
      versionConstraint: maybeVersionConstraint,
      isTest: false,
      job: this,
    });
    this.#packageMap.set(meteorName, meteorPackage);
    return meteorPackage;
  }

  async convertFromExistingIfPossible(meteorPackage, type) {
    // TODO: version control? What if we've moved a package?
    const alreadyConvertedJson = await this.#alreadyConvertedJson(
      meteorPackage.meteorName,
      meteorPackage.version,
      this.#outputDirectories()[type],
    );
    if (alreadyConvertedJson) {
      const isGood = await meteorPackage.loadFromNodeJSON(alreadyConvertedJson);
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
    if (!localOnly && !this.#packageNameToFolderPaths.size) {
      await this.#populatePackageNameToFolderPaths(
        this.#allPackageFolders,
        this.#packageNameToFolderPaths,
      );
    }
    if (localOnly && !this.#localPackageNameToFolderPaths.size) {
      await this.#populatePackageNameToFolderPaths(
        [this.#localFolder, this.#sharedFolder].filter(Boolean),
        this.#localPackageNameToFolderPaths,
      );
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
        this.#meteorInstall,
        packageJsPathObject.packageJsPath,
        packageJsPathObject.type,
      );
    }
    else {
      const pathToISOPackFolder = await this.#pathToISOPack(meteorPackage.meteorName, versionConstraint);
      await meteorPackage.loadFromISOPack(pathToISOPackFolder);
    }
  }

  async ensurePackage(meteorNameAndMaybeVersionConstraint) {
    let forceUpdate = false;
    const [meteorName, maybeVersionConstraint] = meteorNameAndMaybeVersionConstraint.split('@');
    const versionToSatisfy = maybeVersionConstraint
      ? meteorVersionToSemver(maybeVersionConstraint)
      : undefined;

    let meteorPackage = this.#packageMap.get(meteorName);
    if (maybeVersionConstraint && meteorPackage?.isFullyLoaded) {
      // TODO: this whole block is gnarly - it would be better to somehow get the final list of versions, then load exactly those
      if (!meteorPackage.version) {
        await meteorPackage.loaded();
      }
      // we really want ^a.b.c - but since meteor doesn't consider minor version changes of 0 major version packages to be breaking, but semver does
      // we're forced to go with a.x
      // we need to coerce here to handle .rc-1 etc
      if (meteorPackage.version && !versionsAreCompatible(meteorPackage.version, versionToSatisfy)) {
        throw new Error(`invalid package version: ${meteorNameAndMaybeVersionConstraint} requested but ${meteorPackage.version} loaded (${versionToSatisfy})`);
      }
      else if (!meteorPackage.version) {
        logError('missing read version on constrained package', meteorNameAndMaybeVersionConstraint);
      }
      if (!meteorPackage.isLocalOrShared() && semver.gt(semver.coerce(maybeVersionConstraint), semver.coerce(meteorPackage.version))) {
        // this makes things really hard - for example if EJSON reloads and deanius:promise depends on EJSON and has already started converting
        // we need to pause deanius:promise - so we need to "cancelAndDelete" EJSON, then pause the entire tree from there
        // the only time this would be necessary would be if something depends on an export that exists in 1.2.4 but not 1.2.3
        // in this case of direct dependency we should already be fine since this is the point at which that dependency is loaded
        // so awaiting below is all that is necessary
        // this.#packageMap.delete(meteorName);
        forceUpdate = true;
        warn(
          'we loaded an older version of package',
          meteorName,
          meteorPackage.version,
          'initially, but we\'re reloading the requested version',
          maybeVersionConstraint,
        );
        await meteorPackage.cancelAndDelete(meteorPackage.outputParentFolder(this.#outputDirectories()));
        await meteorPackage.rewriteDependants(this.#outputDirectories());
      }
    }
    if (!this.#packageMap.get(meteorName)?.isFullyLoaded) {
      meteorPackage = this.#packageMap.get(meteorName) || this.warmPackage(meteorNameAndMaybeVersionConstraint);
      meteorPackage.isFullyLoaded = true; // TODO: this probably shouldn't be here, but we need to make sure it happens before any other await
      if (!this.#options.forceRefresh) {
        let shouldSkip = !forceUpdate;
        if (shouldSkip) {
          // if the package exists in a "local" dir, we're not gonna convert it
          shouldSkip = !await this.#findPackageJs(meteorName, true);
        }
        if (shouldSkip) {
          const alreadyConvertedJson = await this.#alreadyConvertedJson(meteorName, maybeVersionConstraint);
          if (alreadyConvertedJson) {
            const isGood = await meteorPackage.loadFromNodeJSON(alreadyConvertedJson);
            if (isGood) {
              return false;
            }
          }
        }
      }
      await this.loadPackage(meteorPackage, maybeVersionConstraint);
      if (versionToSatisfy) {
        if (
          semver.gt(semver.coerce(maybeVersionConstraint), semver.coerce(meteorPackage.version))
          || !versionsAreCompatible(meteorPackage.version, versionToSatisfy)
        ) {
          throw new Error(`the loaded version ${meteorPackage.version} of ${meteorName} does not satisfy the constraint ${versionToSatisfy}`);
        }
      }
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
