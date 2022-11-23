import esbuild from 'esbuild';
import fs from 'fs/promises';
import fsExtra from 'fs-extra';
import path from 'path';

import listFilesInDir from '../../helpers/list-files';
import readPackageJson from '../../helpers/read-package-json';
import ensureBuildDirectory from '../ensure-build-directory.js';
import generateProgram from './generate-program';
import { meteorNameToLegacyPackageDir, nodeNameToMeteorName } from '../../helpers/helpers.js';
import { ParentArchs } from '../../constants.js';
import blazePlugin from './blaze-plugin.js';
import lessPlugin from './less-plugin.js';
import stubsPlugin from './stubs-plugin.js';
import onStart from './start-plugin.js';
import onEnd from './end-plugin.js';
import Cache from '../cache.js';
import addJsExtension from './add-js-extension';

// can't actually be weak since `build` is new each time.
const weakMap = new Map();

async function buildClient({
  archName,
  packageJson,
  isProduction,
  outputBuildFolder,
  appProcess,
}) {
  const entryPoint = packageJson.meteor.mainModule[archName] || packageJson.meteor.mainModule.client;
  const outdir = `${outputBuildFolder}/${archName}`;
  let isInitial = true;
  const buildRoot = path.resolve('./');
  const cacheDirectory = path.resolve(path.join(outputBuildFolder, 'cache'));
  const wasPaused = new Map();
  const cache = new Cache(cacheDirectory);
  await cache.init();

  // eslint-disable-next-line
  const build = await esbuild.build({
    absWorkingDir: process.cwd(), // it doesn't seem like this shoudl be needed, but because the test-packages commands uses chdir it seems it is
    minify: isProduction,
    entryPoints: [entryPoint],
    outdir,
    conditions: [isProduction ? 'production' : 'development', archName],
    external: [
      '*.jpg',
      '*.png',
      '*.svg',
      '/fonts/*',
      '/packages/*', // for things like qualia_semantic that hardcode the URL
    ],
    sourcemap: 'linked',
    logLevel: 'error',
    define: {
      'Meteor.isServer': 'false',
      'Meteor.isClient': 'true',
      'Meteor.isModern': archName === 'web.browser' ? 'true' : 'false',
      global: 'globalThis', // hack mostly for util (or any other npm dependency of a meteor package that looks for global)
      '__package_globals.require': 'require',
    },
    plugins: [
      blazePlugin(cache),
      lessPlugin(cache),
      stubsPlugin(buildRoot),
      addJsExtension(buildRoot),
      onStart(async () => {
        if (isInitial) {
          return;
        }
        if (appProcess) {
          wasPaused.set(archName, await appProcess.pauseClient(archName));
        }
      }, weakMap),
      onEnd(async (build, result) => {
        if (isInitial) {
          return;
        }
        if (result.errors?.length) {
          return;
        }
        await writeProgramJSON(
          archName,
          {
            outputs: Object.keys(result.metafile.outputs),
            isProduction,
            packageJson,
            outputBuildFolder,
          },
        );
        // if the process was killed (e.g., a parallel server rebuild) then there's no need to refresh the client.
        if (appProcess && wasPaused.get(archName)) {
          appProcess.refreshClient(archName);
        }
      }, weakMap),
    ],
    splitting: archName === 'web.browser',
    bundle: true,
    format: archName === 'web.browser' ? 'esm' : 'iife',
    watch: !isProduction,
    incremental: !isProduction,
    metafile: true,
  });
  isInitial = false;
  return Object.keys(build.metafile.outputs);
}

function allAssetsForArch(archName, packageJson, ret = []) {
  if (packageJson.meteor?.assets?.[archName]) {
    ret.push(...packageJson.meteor.assets[archName]);
  }
  if (ParentArchs.has(archName)) {
    return allAssetsForArch(ParentArchs.get(archName), packageJson, ret);
  }
  return ret;
}

async function loadAndListPackageAssets({
  archName,
  dep,
  isProduction,
  copyToDestination,
  outputBuildFolder,
  loaded,
}) {
  if (loaded.has(dep)) {
    return [];
  }
  loaded.add(dep);
  if (!await fsExtra.pathExists(`./node_modules/${dep}/package.json`)) {
    return [];
  }
  const packageJson = JSON.parse((await fs.readFile(`./node_modules/${dep}/package.json`)).toString());
  const assets = allAssetsForArch(archName, packageJson);
  const folderName = meteorNameToLegacyPackageDir(nodeNameToMeteorName(dep));
  if (copyToDestination && assets.length) {
    await fsExtra.ensureDir(`${outputBuildFolder}/${archName}/packages/${folderName}`);
    await Promise.all(assets.map(async (asset) => {
      await fsExtra.copy(`./node_modules/${dep}/${asset}`, `${outputBuildFolder}/${archName}/packages/${folderName}/${asset}`);
    }));
  }
  else if (assets.length) {
    await fsExtra.ensureSymlink(`./node_modules/${dep}`, `${outputBuildFolder}/${archName}/packages/${folderName}`);
  }
  return linkAssetsOfPackage({
    archName,
    packageJson,
    assetPaths: assets.map((assetPath) => `packages/${folderName}/${assetPath}`),
    isProduction,
    copyToDestination,
    outputBuildFolder,
    loaded,
  });
}

async function linkAssetsOfPackage({
  archName,
  packageJson,
  assetPaths = [],
  isProduction,
  copyToDestination,
  outputBuildFolder,
  loaded,
}) {
  if (!packageJson.dependencies) {
    return [];
  }
  return [
    ...assetPaths,
    ...(await Promise.all(Object.keys(packageJson.dependencies).map((dep) => loadAndListPackageAssets({
      archName,
      dep,
      isProduction,
      copyToDestination,
      outputBuildFolder,
      loaded,
    })))).flat(),
  ];
}

async function listAndMaybeCopyFilesInPublic({
  archName,
  copyToDestination,
  outputBuildFolder,
}) {
  if (await fsExtra.pathExists('./public')) {
    const publicFiles = await listFilesInDir('./public');
    if (copyToDestination) {
      await fsExtra.ensureDir(`${outputBuildFolder}/${archName}/app/`);
      await Promise.all(publicFiles.map(async (fileOrFolder) => fsExtra.copy(
        fileOrFolder,
        `${outputBuildFolder}/${archName}/app/${fileOrFolder.replace('public/', '')}`,
      )));
    }
    else {
      await fsExtra.ensureSymlink('./public', `${outputBuildFolder}/${archName}/app`);
    }
    return (publicFiles).map((name) => `app/${name.replace(/^public\//, '')}`);
  }
  return [];
}

async function linkOrCopyAssets({
  archName,
  packageJson,
  isProduction,
  copyToDestination = isProduction,
  outputBuildFolder,
}) {
  const loaded = new Set();
  return [
    ...await listAndMaybeCopyFilesInPublic({
      archName,
      copyToDestination,
      outputBuildFolder,
    }),
    ...await linkAssetsOfPackage({
      archName,
      packageJson,
      isProduction,
      copyToDestination,
      outputBuildFolder,
      loaded,
    }),
  ];
}

async function writeProgramJSON(
  archName,
  {
    outputs = [],
    packageJson,
    isProduction,
    outputBuildFolder,
  } = {},
) {
  const assets = await linkOrCopyAssets({
    archName,
    packageJson,
    isProduction,
    outputBuildFolder,
  });
  const allAssets = [
    ...outputs.map((file) => {
      let type;
      if (file.endsWith('.map')) {
        type = 'asset';
      }
      else if (file.endsWith('.js')) {
        if (file.endsWith('main.js')) {
          type = 'module js';
        }
        else {
          type = 'dynamic js';
        }
      }
      else {
        type = file.split('.').slice(-1)[0];
      }
      return {
        file,
        path: file.replace(path.join(outputBuildFolder.replace(/^\.\//, ''), archName) + "/", ''),
        where: 'client',
        type,
        cacheable: true,
        replacable: false,
      };
    }),
    ...assets.map((asset) => ({
      file: `${outputBuildFolder}/${archName}/${asset}`,
      path: asset,
      type: 'asset',
      where: 'client',
      cacheable: false,
      replacable: false,
    })),
  ];

  const programJSON = await generateProgram(allAssets);
  const str = JSON.stringify(programJSON, null, 2);
  await fs.writeFile(`${outputBuildFolder}/${archName}/program.json`, str);
  return str;
}

export default async function generateWebBrowser(
  archName,
  {
    appProcess,
    isProduction,
    outputBuildFolder,
  } = {},
) {
  const packageJson = await readPackageJson();
  await ensureBuildDirectory(archName);

  if (isProduction) {

  }
  else {
    if (await fsExtra.pathExists(`${outputBuildFolder}/${archName}/__client.js`)) {
      await fs.unlink(`${outputBuildFolder}/${archName}/__client.js`);
    }
    await fsExtra.ensureSymlink(
      packageJson.meteor.mainModule[archName] || packageJson.meteor.mainModule.client,
      `${outputBuildFolder}/${archName}/__client.js`,
    );
  }
  const outputs = await buildClient({
    archName,
    packageJson,
    isProduction,
    outputBuildFolder,
    appProcess,
  });
  await writeProgramJSON(
    archName,
    {
      outputs,
      appProcess,
      isProduction,
      packageJson,
      outputBuildFolder,
    },
  );
}
