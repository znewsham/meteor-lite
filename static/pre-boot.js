import path from 'path';
import fs from 'fs';
import './assets.js';

// this object is required by meteor, isMeteorLite is just a helper so we know if we're really in meteor
globalThis.__meteor_runtime_config__ = {
  isMeteorLite: true,
};
const serverJsonPath = path.join(path.dirname(import.meta.url), 'config.json').replace('file:', '');
const serverDir = path.dirname(serverJsonPath);
const configJson = JSON.parse(fs.readFileSync(path.resolve(serverDir, 'config.json'), 'utf8'));

globalThis.__meteor_bootstrap__ = {
  startupHooks: [],
  serverDir,
  configJson,
};
