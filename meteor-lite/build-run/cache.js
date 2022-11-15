import fs from 'fs/promises';
import fsExtra from 'fs-extra';
import crypto from 'crypto';
import path from 'path';
import AsyncLock from 'async-lock';

export default class Cache {
  #cacheDirectory;

  #map = new Map();

  #lock = new AsyncLock();

  constructor(cacheDirectory) {
    this.#cacheDirectory = cacheDirectory;
  }

  async init() {
    await fsExtra.ensureDir(this.#cacheDirectory);
  }

  async #readFromDirectory(filePath, mtimeMs) {
    const fileName = Cache.#getFileCacheKey(filePath);
    const finalPath = path.join(this.#cacheDirectory, fileName);
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

  async #writeToDirectory(filePath, contents) {
    const fileName = Cache.#getFileCacheKey(filePath);
    const finalPath = path.join(this.#cacheDirectory, fileName);
    await fsExtra.writeFile(finalPath, contents);
  }

  async getCacheKey(filePath) {
    return this.constructor.getCacheKey(filePath);
  }

  static async getCacheKey(filePath) {
    const stats = await fsExtra.stat(filePath);
    return stats.mtime;
  }

  static #getFileCacheKey(filePath) {
    return crypto
      .createHash('sha256')
      .update(filePath)
      .digest('base64')
      .split('/')
      .join('');
  }

  async get(filePath) {
    return this.#lock.acquire(filePath, async () => {
      const stat = await fs.stat(filePath);
      const cacheKey = stat.mtime.getTime();
      if (this.#map.has(filePath)) {
        const cached = this.#map.get(filePath);
        if (cached && cached.cacheKey !== cacheKey) {
          await this.invalidate(filePath);
          return undefined;
        }
        return cached;
      }

      const cacheContents = await this.#readFromDirectory(filePath, stat.mtimeMs);
      if (cacheContents !== undefined) {
        const res = {
          contents: cacheContents,
          cacheKey,
          invalidates: new Set(),
        };
        this.#map.set(filePath, res);
        return res;
      }
      return undefined;
    });
  }

  async set(filePath, contents) {
    return this.#lock.acquire(filePath, async () => {
      const stat = await fs.stat(filePath);
      const cacheKey = stat.mtime.toString();
      this.#map.set(
        filePath,
        {
          contents,
          cacheKey,
          invalidates: new Set(),
        },
      );
      await this.#writeToDirectory(filePath, contents);
    });
  }

  addInvalidator(filePath, invalidates) {
    const entry = this.#map.get(filePath);
    if (!entry) {
      return;
    }
    entry.invalidates.add(invalidates);
  }

  async invalidate(filePath) {
    const entry = this.#map.get(filePath);
    this.#map.delete(filePath);
    if (!entry) {
      return;
    }
    entry.invalidates.forEach((imp) => this.invalidate(imp));
  }
}
