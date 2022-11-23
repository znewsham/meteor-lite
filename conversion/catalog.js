import { ExcludePackageNames } from '../constants';
import { getAllPackageVersions } from '../helpers/ensure-local-package';
import { TestSuffix } from './meteor-package';

async function loadVersionParser() {
  await import('@meteor/meteor');
  return (await import('@meteor/package-version-parser')).default;
}

export default class Catalog {
  // packageName => versionRecord
  #localPackages = new Map();

  // packageName@version => versionRecord
  #remotePackages = new Map();

  #versionsForPackages = new Map();

  #meteorInstall;

  #versionParser;

  constructor(meteorInstall, localPackages) {
    this.#meteorInstall = meteorInstall;
    this.#localPackages = localPackages;
  }

  #getVersionFromPackageDB(pkg, version) {
    const remotePackage = this.#remotePackages.get(`${pkg}@${version}`);
    if (!remotePackage) {
      return null;
    }
    return remotePackage.versionRecord;
  }

  #getSortedVersionsFromPackageDB(pkg) {
    const versions = this.#versionsForPackages.get(pkg);
    if (!versions) {
      return [];
    }
    const versionRecords = versions.map((version) => this.#getVersionFromPackageDB(pkg, version));
    versionRecords.sort((a, b) => this.#versionParser.compare(
      this.#versionParser.parse(a.version),
      this.#versionParser.parse(b.version),
    ));
    if (pkg === 'babel-compiler') {
      console.log(pkg, versionRecords.reverse());
    }
    return versionRecords;
  }

  async init() {
    this.#versionParser = await loadVersionParser();
    const allPackageVersions = await getAllPackageVersions({
      meteorInstall: this.#meteorInstall,
    });
    allPackageVersions.forEach(({ packageName, version, content }) => {
      if (!this.#versionsForPackages.has(packageName)) {
        this.#versionsForPackages.set(packageName, []);
      }
      this.#versionsForPackages.get(packageName).push(version);
      const parsed = JSON.parse(content);
      parsed.dependencies = Object.fromEntries(Object.entries(parsed.dependencies).filter(([name]) => !ExcludePackageNames.has(name)));
      this.#remotePackages.set(`${packageName}@${version}`, { versionRecord: parsed });
    });
  }

  getSortedVersionRecords(pkg) {
    let actualPkgName = pkg;
    let isTest = false;
    if (pkg.endsWith(TestSuffix)) {
      isTest = true;
      actualPkgName = pkg.replace(TestSuffix, '');
    }
    const localPackage = this.#localPackages.get(actualPkgName);
    if (!localPackage && isTest) {
      throw new Error(`tried to load test package ${actualPkgName} but no source code found`);
    }
    if (!localPackage) {
      return this.#getSortedVersionsFromPackageDB(actualPkgName);
    }
    const versionRecord = isTest ? localPackage.testVersionRecord : localPackage.versionRecord;
    return [versionRecord];
  }

  getVersion(pkg, version) {
    let actualPkgName = pkg;
    let isTest = false;
    if (pkg.endsWith(TestSuffix)) {
      isTest = true;
      actualPkgName = pkg.replace(TestSuffix, '');
    }
    const localPackage = this.#localPackages.get(actualPkgName);
    if (!localPackage && isTest) {
      throw new Error(`tried to load test package ${actualPkgName} but no source code found`);
    }
    if (!localPackage) {
      return this.#getVersionFromPackageDB(actualPkgName, version);
    }
    const versionRecord = isTest ? localPackage.testVersionRecord : localPackage.versionRecord;
    if (version !== versionRecord.version) {
      return null;
    }
    return versionRecord;
  }
}
