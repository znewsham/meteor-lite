import fs from 'fs/promises';
import crypto from 'crypto';
import fsExtra from 'fs-extra';
import path from 'path';
import { meteorNameToNodePackageDir, nodeNameToMeteorName } from './helpers.js';

export const baseFolder = './.meteor';
export const baseBuildFolder = `${baseFolder}/local`;

async function getPackageExports(outputDirectory, meteorPackageName, clientOrServer, map) {
  try {
    if (!map.has(meteorPackageName)) {
      map.set(meteorPackageName, new Set());
    }
    const packageJson = JSON.parse((await fs.readFile(path.join(path.resolve(outputDirectory), meteorNameToNodePackageDir(meteorPackageName), 'package.json'))).toString());
    if (packageJson.implies[clientOrServer]?.length) {
      await Promise.all(packageJson.implies[clientOrServer].map((packageName) => getPackageExports(outputDirectory, nodeNameToMeteorName(packageName), clientOrServer, map)));
    }
    (packageJson.exportedVars?.[clientOrServer] || []).forEach((name) => map.get(meteorPackageName).add(name));
  }
  catch (e) {
    console.error(new Error(`problem with package ${meteorPackageName}`));
    console.error(e);
    throw e;
  }
}

export async function generateGlobals(outputDirectory, packages, clientOrServer) {
  const map = new Map();
  const meteorPackages = packages;
  await Promise.all(meteorPackages.map((packageName) => getPackageExports(outputDirectory, packageName, clientOrServer, map)));
  return map;
}

export async function readPackageJson() {
  return JSON.parse((await fs.readFile('./package.json')).toString());
}

export async function ensureBuildDirectory(name, outputBuildFolder = baseBuildFolder) {
  return fsExtra.ensureDir(`${outputBuildFolder}/${name}`);
}

export async function listFilesInDir(dir, depthOrBreadth = 'breadth') {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const inner = (await Promise.all(entries.filter((entry) => entry.isDirectory())
      .map((dirEnt) => listFilesInDir(path.join(dir, dirEnt.name)), depthOrBreadth))).flat();
    return [
      ...(depthOrBreadth === 'depth' ? inner : []),
      ...entries.filter((entry) => entry.isFile()).map((dirEnt) => path.join(dir, dirEnt.name)),
      ...(depthOrBreadth === 'breadth' ? inner : []),
    ];
  }
  catch (e) {
    console.error(`problem with ${dir}`);
    console.error(e);
    throw e;
  }
}

export async function getProgramEntry(asset) {
  const { file, ...remainderOfAsset } = asset;
  const buffer = await fs.readFile(file);
  const hashSum = crypto.createHash('sha256');
  hashSum.update(buffer);
  const hash = hashSum.digest('hex');
  return {
    where: 'client',
    hash,
    size: buffer.length,
    ...remainderOfAsset,
    url: `/${remainderOfAsset.cacheable ? `${remainderOfAsset.path.replace(/^app\//, '')}?hash=${hash}` : remainderOfAsset.path.replace(/^app\//, '')}`,
  };
}

export async function generateProgram(allAssets) {
  const allAssetEntries = await Promise.all(allAssets.map(getProgramEntry));
  return {
    format: 'web-program-pre1',
    manifest: allAssetEntries,
  };
}
