import path from 'path';
import fs from 'fs';
import './assets.js';

// AsyncHook.enable();

global.__meteor_runtime_config__ = {
  isMeteorLite: true,
};
const serverJsonPath = path.join(path.dirname(import.meta.url), 'config.json').replace('file:', '');
// var serverJsonPath = path.resolve('./server/config.json');
const serverDir = path.dirname(serverJsonPath);
const configJson = JSON.parse(fs.readFileSync(path.resolve(serverDir, 'config.json'), 'utf8'));

global.__meteor_bootstrap__ = {
  startupHooks: [],
  serverDir,
  configJson,
};
