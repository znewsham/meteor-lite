import esbuild from 'esbuild';
import fs from 'fs/promises';
import fsExtra from 'fs-extra';
import path from 'path';

const blazePlugin = {
  name: 'blaze',
  async setup(build) {
    const { TemplatingTools } = await import('@meteor/templating-tools');
    build.onLoad(
      { filter: /\.html$/ },
      async ({ path: filePath }) => {
        const contents = (await fs.readFile(filePath)).toString();
        const tags = TemplatingTools.scanHtmlForTags({
          sourceName: filePath,
          contents: contents,
          tagNames: ["body", "head", "template"]
        });
        const result = TemplatingTools.compileTagsWithSpacebars(tags);

        // most app html files don't need this (and can't use it anyway) but package globals aren't global anymore, so we need to import them
        // this happens as part of the conversion for JS, but HTML is compiled OTF.
        const needsImport = filePath.includes('/node_modules/') || filePath.includes('/packages/'); // hack for symlinks
  
        // TODO: spacebars?
        const importStr = [
          `import __globals__ from '${path.resolve(path.dirname(filePath))}/__globals.js';`,
          'const Template = __globals__.Template'
        ].join('\n');
        
        return {
          contents: `${needsImport ? importStr : ''}${result.js}`,
          loader: 'js'
        };
      }
    )
  }
}

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
    plugins: [blazePlugin],
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
  await Promise.all([
    fsExtra.ensureSymlink('./public', `${baseBuildFolder}/web.browser/app`),
    fsExtra.ensureSymlink(packageJson.meteor.mainModule.client, `${baseBuildFolder}/web.browser/__client.js`)
  ]);

  return [
    ...(await listFilesInDir('./public')).map(name => `app/${name}`),
    ...await linkAssetsOfPackage(packageJson),
  ];
}

export default async function generateWebBrowser() {
  const packageJson = await readPackageJson();
  await ensureBuildDirectory('web.browser');
  const assets = await linkAssets(packageJson);
  await buildClient(packageJson);
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
    ...(await fsExtra.pathExists(`${baseBuildFolder}/web.browser/app.css`) ? [
      {
        file: `${baseBuildFolder}/web.browser/app.css`,
        path: 'app.css',
        type: 'css',
        where: 'client',
        cacheable: true,
        replacable: false,
        sri: "KyhHP+B/AM6Nh9FGFPXwbb4bQxAfytYjNxs1s/ZAvC6S1wl3ubMXdcLww+xBBoxlaPRabOmKBFmOsaam4zhxQQ=="
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
