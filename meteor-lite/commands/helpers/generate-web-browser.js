import esbuild from 'esbuild';
import fs from 'fs/promises';
import fsExtra from 'fs-extra';
import less from 'less';
import path from 'path';
import crypto from 'crypto';

import {
  listFilesInDir, generateProgram, ensureBuildDirectory, readPackageJson,
} from './command-helpers.js';
import { meteorNameToLegacyPackageDir, nodeNameToMeteorName } from '../../helpers/helpers.js';
import { ParentArchs } from '../../constants.js';

function getFileCacheKey(filePath) {
  return crypto.createHash('sha256').update(filePath).digest('base64').split('/').join('');
}

async function getCacheEntry(cacheDirectory, filePath, mtimeMs) {
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

async function setCacheEntry(cacheDirectory, filePath, contents) {
  const fileName = getFileCacheKey(filePath);
  const finalPath = path.join(cacheDirectory, fileName);
  await fsExtra.writeFile(finalPath, contents);
}

let guessStarted = null;
const cacheMap = new Map();
function lessPlugin(cacheDirectory) {
  return {
    name: 'less',
    async setup(build) {
      build.onLoad(
        { filter: /.(less|lessimport)$/ },
        async ({ path: filePath }) => {
          if (!guessStarted) {
            guessStarted = new Date().getTime();
          }
          const stat = await fs.stat(filePath);
          const cacheKey = stat.mtime.toString();
          const cached = cacheMap.get(filePath);
          if (cached && cached.cacheKey === cacheKey) {
            return cached.result;
          }
          if (cached) {
            cached.invalidates.forEach((invalidated) => cacheMap.delete(invalidated));
          }
          if (filePath.endsWith('.import.less')) {
            const res = {
              contents: '',
              loader: 'css',
            };
            cacheMap.set(filePath, { result: res, cacheKey, invalidates: new Set() });
            return res;
          }
          if (cacheDirectory) {
            const cacheContents = await getCacheEntry(cacheDirectory, filePath, stat.mtimeMs);
            if (cacheContents) {
              const res = {
                contents: cacheContents,
                loader: 'css',
              };
              cacheMap.set({
                result: res,
                cacheKey,
                invalidates: new Set(),
              });
              return res;
            }
          }
          const result = await less.render((await fs.readFile(filePath)).toString('utf8'), {
            filename: filePath,
            plugins: [/* importPlugin */],
            javascriptEnabled: true,
            sourceMap: { outputSourceFiles: true },
          });

          if (cacheDirectory) {
            setCacheEntry(cacheDirectory, filePath, result.css);
          }

          const res = {
            contents: result.css,
            loader: 'css',
          };

          cacheMap.set(filePath, {
            result: res,
            cacheKey,
            invalidates: new Set(),
          });
          result.imports.forEach((imp) => {
            cacheMap.get(imp).invalidates.add(filePath);
          });

          return res;
        },
      );
    },
  };
}

function blazePlugin(cacheDirectory) {
  return {
    name: 'blaze',
    async setup(build) {
      const { TemplatingTools } = await import('@meteor/templating-tools');
      build.onLoad(
        { filter: /\.html$/ },
        async ({ path: filePath }) => {
          if (!guessStarted) {
            guessStarted = new Date().getTime();
          }
          const start = new Date().getTime();
          const stat = await fs.stat(filePath);
          const cacheKey = stat.mtime.toString();
          if (cacheMap.has(filePath)) {
            const cached = cacheMap.get(filePath);
            if (cached.cacheKey === cacheKey) {
              return cached.result;
            }
          }

          if (cacheDirectory) {
            const cacheContents = await getCacheEntry(cacheDirectory, filePath, stat.mtimeMs);
            if (cacheContents) {
              const res = {
                contents: cacheContents,
                loader: 'js',
              };
              cacheMap.set({
                result: res,
                cacheKey,
              });
              return res;
            }
          }
          const contents = (await fs.readFile(filePath)).toString();
          const tags = TemplatingTools.scanHtmlForTags({
            sourceName: filePath,
            contents,
            tagNames: ['body', 'head', 'template'],
          });
          const result = TemplatingTools.compileTagsWithSpacebars(tags);
          // most app html files don't need this (and can't use it anyway) but package globals aren't global anymore, so we need to import them
          // this happens as part of the conversion for JS, but HTML is compiled OTF.
          // TODO: move this to a static file
          const needsImport = true; // filePath.includes('/node_modules/') || filePath.includes('/npm-packages/') || filePath.includes('/packages/'); // hack for symlinks
          const importStr = [
            filePath.includes('templating-runtime')
              ? 'import globals from "./__globals.js"; const { Template } = globals'
              : 'import { Template } from "@meteor/templating-runtime"',
            'import { HTML } from "@meteor/htmljs";',
            'import { Blaze } from "@meteor/blaze";',
            'import { Spacebars } from "@meteor/spacebars";',
          ].join('\n');
          const res = {
            contents: `${needsImport ? importStr : ''}${result.js}`,
            loader: 'js',
          };

          if (cacheDirectory) {
            setCacheEntry(cacheDirectory, filePath, res.contents);
          }

          cacheMap.set(filePath, { result: res, cacheKey });
          return res;
        },
      );
    },
  };
}

// can't actually be weak since `build` is new each time.
const weakMap = new Map();
function onStart(onStartHandler) {
  return {
    name: 'on-start',
    setup(build) {
      build.onStart((...args) => {
        const arch = build.initialOptions.conditions.slice(-1)[0];
        console.log('build started', arch, build.initialOptions.entryPoints);
        weakMap.set(arch, new Date());
        if (onStartHandler) {
          onStartHandler(build, ...args);
        }
      });
    },
  };
}
function onEnd(onEndHandler) {
  return {
    name: 'on-end',
    setup(build) {
      build.onEnd((...args) => {
        const arch = build.initialOptions.conditions.slice(-1)[0];
        const start = weakMap.get(arch);
        console.log('build ended', arch, build.initialOptions.entryPoints, (new Date().getTime() - start.getTime()) / 1000);
        if (onEndHandler) {
          onEndHandler(build, ...args);
        }
      });
    },
  };
}

async function buildClient({
  archName,
  packageJson,
  isProduction,
  outputBuildFolder,
  appProcess,
}) {
  const entryPoint = packageJson.meteor.mainModule[archName] || packageJson.meteor.mainModule.client;
  const outdir = `${outputBuildFolder}/${archName}`;
  let isRoot = true;
  let isInitial = true;
  let rootBuild;
  const cacheDirectory = path.resolve(path.join(outputBuildFolder, 'cache'));
  await fsExtra.ensureDir(cacheDirectory);
  // eslint-disable-next-line
  const build = await esbuild.build({
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
      // TODO: these should be passed in
      'util',
    ],
    sourcemap: 'linked',
    logLevel: 'error',
    define: {
      'Meteor.isServer': 'false',
      'Meteor.isClient': 'true',
      'Meteor.isModern': archName === 'web.browser' ? 'true' : 'false',
      '__package_globals.require': 'require',
    },
    plugins: [
      blazePlugin(cacheDirectory),
      lessPlugin(cacheDirectory),
      onStart(async () => {
        if (isInitial) {
          return;
        }
        if (appProcess) {
          await appProcess.pauseClient(archName);
        }
      }),
      onEnd(async (build, result) => {
        if (isInitial) {
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
        if (appProcess) {
          appProcess.refreshClient(archName);
        }
      }),
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
