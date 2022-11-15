import crypto from 'crypto';
import fsExtra from 'fs-extra';
import path from 'path';

export function getFileCacheKey(filePath) {
  return crypto.createHash('sha256').update(filePath).digest('base64').split('/').join('');
}

export async function getCacheEntry(cacheDirectory, filePath, mtimeMs) {
  const fileName = getFileCacheKey(filePath);
  const finalPath = path.join(cacheDirectory, fileName);
  if (await fsExtra.pathExists(finalPath)) {
    const stats = await fsExtra.stat(finalPath);
    if (stats.mtimeMs > mtimeMs) {
      // the cache entry is newer than modification date on the file
      const res = (await fsExtra.readFile(finalPath)).toString();
      return res;
    }
  }
  return undefined;
}

export async function setCacheEntry(cacheDirectory, filePath, contents) {
  const fileName = getFileCacheKey(filePath);
  const finalPath = path.join(cacheDirectory, fileName);
  await fsExtra.writeFile(finalPath, contents);
}
