import path from 'path';
import fs from 'fs-extra';
import sqlite3 from 'sqlite3';
import fetch from 'node-fetch';
import targz from 'targz';
import semver from 'semver';
import { meteorNameToLegacyPackageDir, sortSemver, versionsAreCompatible } from './helpers';

const DBMap = new Map();

async function getOne(db, query) {
  return new Promise((resolve, reject) => {
    db.get(query, (err, res) => {
      if (err) {
        reject(err);
      }
      else {
        resolve(res);
      }
    });
  });
}

async function getAll(db, query) {
  return new Promise((resolve, reject) => {
    db.all(query, (err, res) => {
      if (err) {
        reject(err);
      }
      else {
        resolve(res);
      }
    });
  });
}

async function getAllFilesAndFolders(folderPath, res = []) {
  const partial = await fs.readdir(folderPath, { withFileTypes: true });
  const folders = partial.filter((file) => file.isDirectory()).map((folder) => folder.name);
  res.push(...partial.map((file) => path.join(folderPath, file.name)));
  await Promise.all(folders.map((folder) => getAllFilesAndFolders(path.join(folderPath, folder), res)));
  return res;
}

async function installPackage(packageVersionObject, packageVersionBuildObject, meteorInstall) {
  const tarGzReponse = await fetch(packageVersionBuildObject.build.url);
  const cleanName = meteorNameToLegacyPackageDir(packageVersionObject.packageName);
  const packageNameVersion = `${cleanName}-${packageVersionObject.version}`;
  const extractFolderName = `${packageNameVersion}-${Math.random()}`;
  const tarGzPath = path.join('/tmp', `${extractFolderName}.tar.gz`);
  const extractFolderPath = path.join('/tmp', extractFolderName);
  const tarGz = fs.createWriteStream(tarGzPath);
  await new Promise((resolve, reject) => {
    tarGzReponse.body.pipe(tarGz);
    tarGzReponse.body.on('end', () => resolve());
    tarGz.on('error', reject);
  });

  await new Promise((resolve, reject) => {
    targz.decompress({
      src: tarGzPath,
      dest: extractFolderPath,
    }, (err, res) => (err ? reject(err) : resolve(res)));
  });

  await fs.unlink(tarGzPath);

  // no idea where nceq8x.2tumh comes from - probably some kinda hash (but neither of the hashes on packageVersionBuildObject or packageVersionObject)
  // .1.5.1.nceq8x.2tumh++os+web.browser+web.browser.legacy+web.cordova
  const pathToSymLink = path.join(meteorInstall, 'packages', cleanName, packageVersionObject.version);
  const folderName = `.${packageVersionObject.version}++${packageVersionBuildObject.buildArchitectures}`;
  const pathToPackage = path.join(
    meteorInstall,
    'packages',
    cleanName,
    folderName,
  );

  // no consistency of the internal name sadly - sometimes it's clean, sometimes it isn't
  // erasaur:meteor-lodash-3.1.0-os+web.browser+web.cordova
  // otherpackage-x.y.z
  const internalFolderName = (await fs.readdir(extractFolderPath))[0];
  await fs.move(
    path.join(extractFolderPath, internalFolderName),
    pathToPackage,
  );

  const all = await getAllFilesAndFolders(pathToPackage);

  // TODO: way to strong
  await Promise.all(all.map((filePath) => fs.chmod(filePath, '777')));

  await fs.ensureSymlink(folderName, pathToSymLink);
  await fs.rmdir(extractFolderPath);
}

function loadPackageDb(meteorInstall) {
  // TODO: where does v2.0.1 come from? Maybe just grab the first folder?
  const pathToDb = path.join(meteorInstall, 'package-metadata', 'v2.0.1', 'packages.data.db');
  return new sqlite3.Database(pathToDb);
}

function getPackageDb(meteorInstall) {
  if (!DBMap.has(meteorInstall)) {
    DBMap.set(meteorInstall, loadPackageDb(meteorInstall));
  }
  return DBMap.get(meteorInstall);
}

export async function getCorePackageVersion({
  name,
  meteorInstall,
  meteorVersion,
  appVersion = '2.5', // TODO: take this as an argument
}) {
  const db = getPackageDb(meteorInstall);

  const actualVersion = meteorVersion.split('@').reverse()[0];

  const requestedReleaseObject = await getOne(db, `SELECT * FROM releaseVersions WHERE track="METEOR" AND version='${actualVersion}'`);
  const appReleaseObject = await getOne(db, `SELECT * FROM releaseVersions WHERE track="METEOR" AND version='${appVersion}'`);
  const requestedContent = JSON.parse(requestedReleaseObject.content);
  const appContent = JSON.parse(appReleaseObject.content);
  if (!appContent.packages[name]) {
    // it seems that if a package is not "core" in the "current" version of meteor, then calls to api.versionsFrom
    // no longer enforce a specific version. You can see this with meteorhacks:kadira
    // which api.versionsFrom(1.10) and api.uses(jquery) - this should enforce jquery@1.11.3_2 - but it doesnt
    return undefined;
  }
  return requestedContent.packages[name];
}

export default async function ensureLocalPackage({
  name,
  version,
  versionConstraint,
  meteorInstall,
}) {
  if (versionConstraint && version) {
    throw new Error('you can\'t specify both version and versionConstraint');
  }

  const cleanName = meteorNameToLegacyPackageDir(name);
  const db = getPackageDb(meteorInstall);

  let versionToUse = version;
  let allVersions;
  if (!version) {
    allVersions = (await getAll(db, `SELECT * FROM versions WHERE packageName="${name}"`)).map(({ version: aVersion }) => aVersion);
    allVersions = sortSemver(allVersions);
  }
  if (versionConstraint) {
    const versions = allVersions.filter((aVersion) => versionsAreCompatible(aVersion, versionConstraint));
    if (!versions.length) {
      throw new Error(`no version in ${allVersions} satisfies ${versionConstraint}`);
    }
    versionToUse = versions.slice(-1)[0];
  }
  if (!versionToUse) {
    // TODO: this is probably wrong since we're sorting a string - but it also shouldn't be required any more. Maybe we should just throw an error
    versionToUse = allVersions.slice(-1)[0];
    if (!versionToUse) {
      throw new Error(`Package: ${name} does not exist`);
    }
  }
  const pathToPackage = path.join(meteorInstall, 'packages', cleanName, versionToUse);
  if (await fs.pathExists(pathToPackage)) {
    return;
  }
  const availablePackageVersion = await getOne(db, `SELECT * from versions WHERE packageName="${name}" AND version="${versionToUse}"`);
  if (!availablePackageVersion) {
    throw new Error(`Package: ${name} does not exist`);
  }
  const packageVersionBuilds = await getAll(db, `SELECT * from builds WHERE versionId="${availablePackageVersion._id}"`);
  if (packageVersionBuilds.length !== 1) {
    throw new Error(`Invalid number of builds: ${packageVersionBuilds}`);
  }
  const [packageVersionBuild] = packageVersionBuilds;
  await installPackage(
    JSON.parse(availablePackageVersion.content),
    JSON.parse(packageVersionBuild.content),
    meteorInstall,
  );
}

// getCorePackageVersion({ meteorInstall: '/home/vagrant/share/meteor/.meteor/', meteorVersion: '1.10' }).then(console.log)
