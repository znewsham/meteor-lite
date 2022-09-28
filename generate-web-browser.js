import esbuild from 'esbuild';
import fs from 'fs/promises';
import fsExtra from 'fs-extra';

import { listFilesInDir, generateProgram, baseBuildFolder, ensureBuildDirectory, readPackageJson } from './helpers/command-helpers.js';

async function buildClient(packageJson) {
  return esbuild.build({
    entryPoints: [packageJson.meteor.mainModule.client],
    outfile: `${baseBuildFolder}/web.browser/app.js`,
    sourcemap: 'linked',
    define: {
      'Meteor.isServer': 'false',
      '__package_globals.require':'require'
    },
    bundle: true,
  });
}


const loaded = new Set();

async function loadAndListPackageAssets(dep) {
  if (loaded.has(dep)) {
    return [];
  }
  loaded.add(dep);
  const packageJson = JSON.parse((await fs.readFile(`./node_modules/${dep}/package.json`)).toString());
  if (packageJson.assets?.client?.length) {
    await fsExtra.ensureSymlink(`./node_modules/${dep}`, `${baseBuildFolder}/web.browser/packages/${dep.split("/")[1]}`);
  }
  return linkAssetsOfPackage(packageJson);
}

async function linkAssetsOfPackage(packageJson) {
  return [
    ...(packageJson.assets?.client || []).map(name => `packages/${packageJson.name.split("/")[1]}/${name}`),
    ...(await Promise.all(Object.keys(packageJson.dependencies).filter(dep => dep.startsWith('@meteor/')).map(dep => loadAndListPackageAssets(dep)))).flat()
  ]
}

async function linkAssets(packageJson) {
  await fsExtra.ensureSymlink('./public', `${baseBuildFolder}/web.browser/app`);
  return [
    ...(await listFilesInDir('./public')).map(name => `app/${name}`),
    ...await linkAssetsOfPackage(packageJson)
  ];
}

export default async function generateWebBrowser() {
  const packageJson = await readPackageJson();
  await ensureBuildDirectory('web.browser');
  const [, assets] = await Promise.all([
    buildClient(packageJson),
    linkAssets(packageJson)
  ]);
  const allAssets = [
    {
      file: `${baseBuildFolder}/web.browser/app.js`,
      path: 'app.js',
      type: 'js',
      where: 'client',
      cacheable: true,
      replacable: false,
      sri: "KyhHP+B/AM6Nh9FGFPXwbb4bQxAfytYjNxs1s/ZAvC6S1wl3ubMXdcLww+xBBoxlaPRabOmKBFmOsaam4zhxQQ=="
    },
    {
      file: `${baseBuildFolder}/web.browser/app.js.map`,
      path: 'app.js.map',
      type: 'asset',
      where: 'client',
      cacheable: false,
      replacable: false,
    },
    ...assets.map(asset => ({
      file: `${baseBuildFolder}/web.browser/${asset}`,
      path: `${asset}`,
      type: 'asset',
      where: 'client',
      cacheable: false,
      replacable: false,
    }))
  ];

  const programJSON = await generateProgram(allAssets);
  const str = JSON.stringify(programJSON, null, 2);
  await fs.writeFile(`${baseBuildFolder}/web.browser/program.json`, str);
  return str;
}
