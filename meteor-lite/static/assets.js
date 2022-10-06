import fs from 'fs/promises';
import path from 'path';

const basePath = path.join(path.dirname(import.meta.url), 'assets').replace('file:', '');

globalThis.Assets = {
  getText(file) {
    return Promise.await(fs.readFile(path.join(basePath, file))).toString();
  },
};
