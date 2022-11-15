import fs from 'fs/promises';
import crypto from 'crypto';

async function getProgramEntry(asset) {
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
    url: asset.url || `/${remainderOfAsset.cacheable ? `${remainderOfAsset.path.replace(/^app\//, '')}?hash=${hash}` : remainderOfAsset.path.replace(/^app\//, '')}`,
  };
}

export default async function generateProgram(allAssets) {
  const allAssetEntries = await Promise.all(allAssets.map(getProgramEntry));
  return {
    format: 'web-program-pre1',
    manifest: allAssetEntries,
  };
}
