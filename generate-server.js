
import fsExtra from 'fs-extra';
import fs from 'fs/promises';
import { baseFolder, baseBuildFolder, ensureBuildDirectory, readPackageJson } from './helpers/command-helpers.js';
import path from 'path';

const staticPath = path.join(path.dirname(import.meta.url), 'static').replace('file:', '');

async function linkAssets() {
  const packageJson = await readPackageJson();
  return Promise.all([
    fsExtra.ensureSymlink('./private', `${baseBuildFolder}/server/assets`),
    fs.copyFile(path.join(staticPath, 'pre-boot.js'), `${baseBuildFolder}/server/pre-boot.js`),
    fs.copyFile(path.join(staticPath, 'main.js'), `${baseBuildFolder}/server/main.js`),
    fs.copyFile(path.join(staticPath, 'assets.js'), `${baseBuildFolder}/server/assets.js`),
    fs.copyFile(path.join(staticPath, 'post-boot.js'), `${baseBuildFolder}/server/post-boot.js`),
    fsExtra.ensureSymlink(`./${packageJson.meteor.mainModule.server}`, `${baseBuildFolder}/server/entry.js`)
  ]);
}

async function generateConfigJson(archs) {
  return {
    "meteorRelease": (await fs.readFile(`${baseFolder}/release`)).toString().split("\n")[0],
    "appId": (await fs.readFile(`${baseFolder}/.id`)).toString().split("\n").filter(line => line && !line.startsWith("#"))[0],
    "clientArchs": archs
  };
}

export default async function generateServer(archs) {
  await ensureBuildDirectory('server');
  const [, config] = await Promise.all([
    linkAssets(),
    generateConfigJson(archs)
  ]);

  return fsExtra.writeFile(`${baseBuildFolder}/server/config.json`, JSON.stringify(config, null, 2));
}
