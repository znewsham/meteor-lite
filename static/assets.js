import fs from 'fs/promises';
import path from 'path';

// TODO (down the road): swap to @meteor/assets
const basePath = path.join(path.dirname(import.meta.url), 'private').replace('file:', '');

globalThis.Assets = {
  getText(file) {
    return Promise.await(fs.readFile(path.join(basePath, file))).toString();
  },
};
