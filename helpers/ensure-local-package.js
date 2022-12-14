import path from 'path';
import fs from 'fs-extra';
import sqlite3 from 'sqlite3';
import fetch from 'node-fetch';
import targz from 'targz';
import AsyncLock from 'async-lock';
import rimraf from 'rimraf';
import Util from 'util';
import { meteorNameToLegacyPackageDir, sortSemver, versionsAreCompatible } from './helpers';
import { warn } from './log';

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
  if (await fs.pathExists(pathToPackage)) {
    warn('why does this path exist?!', pathToPackage);
    await Util.promisify(rimraf)(pathToPackage);
  }
  await fs.move(
    path.join(extractFolderPath, internalFolderName),
    pathToPackage,
  );

  // NOTE: we're not going to do this - it's an edge case for when two different users are running commands
  // const all = await getAllFilesAndFolders(pathToPackage);
  // await Promise.all(all.map((filePath) => fs.chmod(filePath, '777')));

  await fs.ensureSymlink(folderName, pathToSymLink);
  await fs.rmdir(extractFolderPath);
}

function loadPackageDb(meteorInstall) {
  // HACK: where does v2.0.1 come from? Maybe just grab the first folder?
  const pathToDb = path.join(meteorInstall, 'package-metadata', 'v2.0.1', 'packages.data.db');
  return new sqlite3.Database(pathToDb);
}

function getPackageDb(meteorInstall) {
  if (!DBMap.has(meteorInstall)) {
    DBMap.set(meteorInstall, loadPackageDb(meteorInstall));
  }
  return DBMap.get(meteorInstall);
}

export async function getPackageDependencies({
  name,
  version,
  meteorInstall,
}) {
  try {
    const db = getPackageDb(meteorInstall);
    const packageVersion = await getOne(db, `SELECT * from versions WHERE packageName="${name}" AND version="${version}"`);
    if (!packageVersion) {
      // happens with iron-router, which doesn't exist and less, which should
      return [];
    }
    const dependencies = Object.entries(JSON.parse(packageVersion.content).dependencies);
    return dependencies.map(([depName, opts]) => ({
      name: depName,
      weak: opts.references.every(({ weak }) => weak),
      ...opts,
    }));
  }
  catch (e) {
    e.message = `problem with ${name}: ${e.message}`;
    throw e;
  }
}

export async function getAllPackageVersions({
  meteorInstall,
}) {
  const db = getPackageDb(meteorInstall);
  const packageVersions = await getAll(db, `SELECT * from versions`);
  return packageVersions;
}

export async function getPackageVersions({
  name,
  meteorInstall,
}) {
  const db = getPackageDb(meteorInstall);
  const packageVersions = await getAll(db, `SELECT * from versions WHERE packageName="${name}"`);
  return packageVersions.map(({ version }) => version);
}

const asyncLock = new AsyncLock();

export default async function ensureLocalPackage({
  name,
  version,
  versionConstraint,
  meteorInstall,
}) {
  return asyncLock.acquire(name, async () => {
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
        throw new Error(`no version in ${allVersions} satisfies ${versionConstraint} for ${name}`);
      }
      versionToUse = versions.slice(-1)[0];
    }
    if (!versionToUse) {
      // HACK: this is probably wrong since we're sorting a string - but it also shouldn't be required any more. Maybe we should just throw an error
      versionToUse = allVersions.slice(-1)[0];
      if (!versionToUse) {
        throw new Error(`Package: ${name} does not exist`);
      }
    }
    const pathToPackage = path.join(meteorInstall, 'packages', cleanName, versionToUse);
    if (await fs.pathExists(pathToPackage)) {
      return versionToUse;
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

    return versionToUse;
  });
}
