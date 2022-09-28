import fs from 'fs/promises';
import crypto from 'crypto';
import fsExtra from 'fs-extra';

export const baseFolder = './.meteor';
export const baseBuildFolder = `${baseFolder}/local`;

export async function readPackageJson() {
  return JSON.parse((await fs.readFile('./package.json')).toString());
}

export async function ensureBuildDirectory(name) {
  return fsExtra.ensureDir(`${baseBuildFolder}/${name}`);
}

export async function listFilesInDir(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return [
    ...entries.filter(entry => entry.isFile()).map(dirEnt => dirEnt.name),
    ...(await Promise.all(
      entries.filter(entry => entry.isDirectory())
      .map(dirEnt => listFilesInDir(dirEnt.name))
    )).flat()
  ]
}

export async function getProgramEntry(asset) {
  const { file, ...remainderOfAsset } = asset;
  const buffer = await fs.readFile(file);
  const hashSum = crypto.createHash('sha256');
  hashSum.update(buffer);
  const hash = hashSum.digest('hex');
  return {
    where: "client",
    hash,
    size: buffer.length,
    ...remainderOfAsset,
    url: `/${remainderOfAsset.cacheable ? `${remainderOfAsset.path}?hash=${hash}` : remainderOfAsset.path}`
  };
}

export async function generateProgram(allAssets) {
  const allAssetEntries = await Promise.all(allAssets.map(getProgramEntry));
  return {
    format: "web-program-pre1",
    manifest: allAssetEntries
  }
}
