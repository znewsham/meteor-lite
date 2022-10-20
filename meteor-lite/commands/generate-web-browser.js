import esbuild from 'esbuild';
import fs from 'fs/promises';
import fsExtra from 'fs-extra';
import less from 'less';

import {
  listFilesInDir, generateProgram, baseBuildFolder, ensureBuildDirectory, readPackageJson,
} from '../helpers/command-helpers.js';
import { meteorNameToLegacyPackageDir, meteorNameToNodePackageDir, nodeNameToMeteorName, ParentArchs } from '../helpers/helpers.js';

let guessStarted = null;
const cacheMap = new Map();
const lessPlugin = {
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
        const result = await less.render((await fs.readFile(filePath)).toString('utf8'), {
          filename: filePath,
          plugins: [/*importPlugin*/],
          javascriptEnabled: true,
          sourceMap: { outputSourceFiles: true },
        });

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

const blazePlugin = {
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
        cacheMap.set(filePath, { result: res, cacheKey });
        return res;
      },
    );
  },
};

async function buildClient({
  archName,
  packageJson,
  isProduction,
  outputBuildFolder,
  appProcess,
}) {
  const build = await esbuild.build({
    minify: isProduction,
    entryPoints: [packageJson.meteor.mainModule[archName] || packageJson.meteor.mainModule.client],
    outfile: `${outputBuildFolder}/${archName}/app.js`,
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
    plugins: [blazePlugin, lessPlugin],
    bundle: true,
    ...(!isProduction && {
      watch: {
        async onRebuild(error, result) {
          if (appProcess) {
            console.log('rebuilt');
            await appProcess.pauseClient(archName);
            await writeProgramJSON(
              archName,
              {
                isProduction,
                packageJson,
                outputBuildFolder,
              },
            );
            appProcess.refreshClient(archName);
            console.log('ready');
          }
        },
      },
    }),
  });
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
    packageJson,
    isProduction,
    outputBuildFolder = baseBuildFolder,
  } = {},
) {
  const assets = await linkOrCopyAssets({
    archName,
    packageJson,
    isProduction,
    outputBuildFolder,
  });
  const allAssets = [
    {
      file: `${outputBuildFolder}/${archName}/app.js`,
      path: 'app.js',
      type: 'js',
      where: 'client',
      // TODO?
      cacheable: true,
      // TODO?
      replacable: false,
      // TODO?
      sri: 'KyhHP+B/AM6Nh9FGFPXwbb4bQxAfytYjNxs1s/ZAvC6S1wl3ubMXdcLww+xBBoxlaPRabOmKBFmOsaam4zhxQQ==',
    },
    {
      file: `${outputBuildFolder}/${archName}/app.js.map`,
      path: 'app.js.map',
      type: 'asset',
      where: 'client',
      cacheable: false,
      replacable: false,
    },
    ...(await fsExtra.pathExists(`${outputBuildFolder}/${archName}/app.css`) ? [
      {
        file: `${outputBuildFolder}/${archName}/app.css`,
        path: 'app.css',
        type: 'css',
        where: 'client',
        cacheable: true,
        replacable: false,
        sri: 'KyhHP+B/AM6Nh9FGFPXwbb4bQxAfytYjNxs1s/ZAvC6S1wl3ubMXdcLww+xBBoxlaPRabOmKBFmOsaam4zhxQQ==',
      },
      {
        file: `${outputBuildFolder}/${archName}/app.css.map`,
        path: 'app.css.map',
        type: 'asset',
        where: 'client',
        cacheable: false,
        replacable: false,
      },
    ] : []),
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
    isProduction = false,
    outputBuildFolder = baseBuildFolder,
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
  await buildClient({
    archName,
    packageJson,
    isProduction,
    outputBuildFolder,
    appProcess,
  });
  await writeProgramJSON(
    archName,
    {
      appProcess,
      isProduction,
      packageJson,
      outputBuildFolder,
    },
  );
}
