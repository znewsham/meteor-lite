import esbuild from 'esbuild';
import fs from 'fs/promises';
import fsExtra from 'fs-extra';
import path from 'path';
import less from 'less';

import {
  listFilesInDir, generateProgram, baseBuildFolder, ensureBuildDirectory, readPackageJson,
} from './helpers/command-helpers.js';

let guessStarted = null;
let totalLessTime = 0;
let totalHtmlTime = 0;
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
        const start = new Date().getTime();
        try {
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
            invalidates: new Set()
          });
          result.imports.forEach((imp) => {
            cacheMap.get(imp).invalidates.add(filePath);
          });

          return res;
        }
        finally {
          totalLessTime += (new Date().getTime() - start);
        }
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
        try {
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
        }
        finally {
          totalHtmlTime += (new Date().getTime() - start);
        }
      },
    );
  },
};

async function buildClient(packageJson) {
  const start = new Date().getTime();
  try {
    return await esbuild.build({
      entryPoints: [packageJson.meteor.mainModule.client],
      outfile: `${baseBuildFolder}/web.browser/app.js`,
      external: [
        '@sinonjs/fake-timers',
        '/packages/*',
        '/images/*',
        '/fonts/*',
      ], // css files import from here
      sourcemap: 'linked',
      logLevel: 'error',
      define: {
        'Meteor.isServer': 'false',
        '__package_globals.require': 'require',
      },
      plugins: [blazePlugin, lessPlugin],
      bundle: true,
      incremental: true,
      watch: {
        onRebuild(error, result) {
          console.log(`   less: `, totalLessTime);
          console.log(`   html: `, totalHtmlTime);
          console.log(`   total: `, new Date().getTime() - guessStarted);
          totalLessTime = 0;
          totalHtmlTime = 0;
          guessStarted = null;
        },
      },
    });
  }
  finally {
    const time = new Date().getTime() - start;
    console.log(`esbuild: `, time);
    console.log(`   less: `, totalLessTime);
    console.log(`   html: `, totalHtmlTime);
    totalLessTime = 0;
    totalHtmlTime = 0;
  }
}

const loaded = new Set();

async function loadAndListPackageAssets(dep) {
  if (loaded.has(dep)) {
    return [];
  }
  loaded.add(dep);
  if (!await fsExtra.pathExists(`./node_modules/${dep}/package.json`)) {
    return [];
  }
  const packageJson = JSON.parse((await fs.readFile(`./node_modules/${dep}/package.json`)).toString());
  if (packageJson.assets?.client?.length) {
    await fsExtra.ensureSymlink(`./node_modules/${dep}`, `${baseBuildFolder}/web.browser/packages/${dep.split('/')[1]}`);
  }
  return linkAssetsOfPackage(packageJson);
}

async function linkAssetsOfPackage(packageJson) {
  if (!packageJson.dependencies) {
    return [];
  }
  return [
    ...(packageJson.assets?.client || []).map((name) => `packages/${packageJson.name.split('/')[1]}/${name}`),
    ...(await Promise.all(Object.keys(packageJson.dependencies).map((dep) => loadAndListPackageAssets(dep)))).flat(),
  ];
}

async function listFilesInPublic() {
  if (await fsExtra.pathExists('./public')) {
    await fsExtra.ensureSymlink('./public', `${baseBuildFolder}/web.browser/app`);
    return (await listFilesInDir('./public')).map((name) => `app/${name.replace(/^public\//, '')}`);
  }
  return [];
}

async function linkAssets(packageJson) {
  if (await fsExtra.pathExists(`${baseBuildFolder}/web.browser/__client.js`)) {
    await fs.unlink(`${baseBuildFolder}/web.browser/__client.js`);
  }
  await Promise.all([
    fsExtra.ensureSymlink(packageJson.meteor.mainModule.client, `${baseBuildFolder}/web.browser/__client.js`),
  ]);
  return [
    ...await listFilesInPublic(),
    ...await linkAssetsOfPackage(packageJson),
  ];
}

export default async function generateWebBrowser() {
  const packageJson = await readPackageJson();
  await ensureBuildDirectory('web.browser');
  let start = new Date().getTime();
  const assets = await linkAssets(packageJson);
  console.log('linking: ', (new Date().getTime() - start));
  await buildClient(packageJson);
  const allAssets = [
    {
      file: `${baseBuildFolder}/web.browser/app.js`,
      path: 'app.js',
      type: 'js',
      where: 'client',
      cacheable: true,
      replacable: false,
      sri: 'KyhHP+B/AM6Nh9FGFPXwbb4bQxAfytYjNxs1s/ZAvC6S1wl3ubMXdcLww+xBBoxlaPRabOmKBFmOsaam4zhxQQ==',
    },
    {
      file: `${baseBuildFolder}/web.browser/app.js.map`,
      path: 'app.js.map',
      type: 'asset',
      where: 'client',
      cacheable: false,
      replacable: false,
    },
    ...(await fsExtra.pathExists(`${baseBuildFolder}/web.browser/app.css`) ? [
      {
        file: `${baseBuildFolder}/web.browser/app.css`,
        path: 'app.css',
        type: 'css',
        where: 'client',
        cacheable: true,
        replacable: false,
        sri: 'KyhHP+B/AM6Nh9FGFPXwbb4bQxAfytYjNxs1s/ZAvC6S1wl3ubMXdcLww+xBBoxlaPRabOmKBFmOsaam4zhxQQ==',
      },
      {
        file: `${baseBuildFolder}/web.browser/app.css.map`,
        path: 'app.css.map',
        type: 'asset',
        where: 'client',
        cacheable: false,
        replacable: false,
      },
    ] : []),
    ...assets.map((asset) => ({
      file: `${baseBuildFolder}/web.browser/${asset}`,
      path: asset,
      type: 'asset',
      where: 'client',
      cacheable: false,
      replacable: false,
    })),
  ];

  const programJSON = await generateProgram(allAssets);
  const str = JSON.stringify(programJSON, null, 2);
  await fs.writeFile(`${baseBuildFolder}/web.browser/program.json`, str);
  return str;
}
