import esbuild from 'esbuild';
import fsExtra from 'fs-extra';
import fs from 'fs/promises';
import path from 'path';
import _ from 'underscore';
import {
  baseFolder, ensureBuildDirectory, readPackageJson,
} from '../../commands/helpers/command-helpers.js';
import queueForBuild from './queue-plugin.js';

const staticPath = path.join(path.dirname(import.meta.url), '..', '..', 'static').replace('file:', '');

async function buildServer({
  isProduction,
  outputBuildFolder,
  copyToDestination = true, // sadly right now we need this for file watching.
  packageJson,
  appProcess,
}) {
  const onRebuild = _.debounce(
    async () => {
      console.log('restarting server');
      await appProcess.restartServer();
    },
    100,
  );
  if (copyToDestination) {
    await fsExtra.ensureDir(`${outputBuildFolder}/server/app`);
    const mainModule = `./${packageJson.meteor.mainModule.server}`;
    const queue = [mainModule];
    const buildRoot = path.resolve('./');
    while (queue.length) {
      const files = queue.splice(0, queue.length);
      // eslint-disable-next-line
      const build = await esbuild.build({
        absWorkingDir: process.cwd(), // it doesn't seem like this shoudl be needed, but because the test-packages commands uses chdir it seems it is
        entryPoints: files,
        outbase: './',
        platform: 'node',
        outdir: `${outputBuildFolder}/server/app/`,
        conditions: [isProduction ? 'production' : 'development', 'server'],
        external: ['./node_modules/*', '@/*'],
        logLevel: 'error',
        bundle: true,
        format: 'esm',
        plugins: [queueForBuild(buildRoot, queue)],
        define: {
          'Meteor.isServer': 'true',
          'Meteor.isClient': 'false',
          '__package_globals.require': 'require',
        },
        ...(!isProduction && appProcess !== undefined && {
          watch: {
            onRebuild,
          },
        }),
      });
    }

    return fsExtra.ensureSymlink(
      `${outputBuildFolder}/server/app/${packageJson.meteor.mainModule.server}`,
      `${outputBuildFolder}/server/entry.js`,
    );
  }
  return fsExtra.ensureSymlink(`./${packageJson.meteor.mainModule.server}`, `${outputBuildFolder}/server/entry.js`);
}

async function linkAssets({
  isProduction,
  outputBuildFolder,
  copyToDestination = isProduction,
}) {
  const optional = [];
  if (await fsExtra.pathExists('./private')) {
    if (copyToDestination) {
      await fsExtra.ensureDir(`${outputBuildFolder}/server/assets`);
      optional.push((async () => {
        const files = await fsExtra.readdir('./private');
        return Promise.all(files.map((fileOrFolder) => fsExtra.copy(
          `./private/${fileOrFolder}`,
          `${outputBuildFolder}/server/assets/${fileOrFolder}`,
        )));
      })());
    }
    else {
      optional.push(fsExtra.ensureSymlink('./private', `${outputBuildFolder}/server/assets`));
    }
  }
  if (await fsExtra.pathExists(`${outputBuildFolder}/server/entry.js`)) {
    await fs.unlink(`${outputBuildFolder}/server/entry.js`);
  }
  return Promise.all([
    ...optional,
    fs.copyFile(path.join(staticPath, 'pre-boot.js'), `${outputBuildFolder}/server/pre-boot.js`),
    fs.copyFile(path.join(staticPath, 'main.js'), `${outputBuildFolder}/server/main.js`),
    fs.copyFile(path.join(staticPath, 'assets.js'), `${outputBuildFolder}/server/assets.js`),
    fs.copyFile(path.join(staticPath, 'post-boot.js'), `${outputBuildFolder}/server/post-boot.js`),
  ]);
}

export async function generateConfigJson({
  archs,
}) {
  return {
    meteorRelease: (await fs.readFile(`${baseFolder}/release`)).toString().split('\n')[0],
    appId: (await fs.readFile(`${baseFolder}/.id`)).toString().split('\n').filter((line) => line && !line.startsWith('#'))[0],
    clientArchs: archs,
  };
}

export default async function generateServer(
  archs,
  {
    isProduction,
    outputBuildFolder,
    appProcess,
  },
) {
  await ensureBuildDirectory('server', outputBuildFolder);
  const [, config] = await Promise.all([
    linkAssets({
      isProduction,
      outputBuildFolder,
    }),
    generateConfigJson({
      archs,
      isProduction,
      outputBuildFolder,
    }),
    !isProduction ? fsExtra.ensureSymlink('./node_modules', `${outputBuildFolder}/server/node_modules`) : undefined,
    !isProduction ? fsExtra.ensureSymlink('./package.json', `${outputBuildFolder}/server/package.json`) : undefined,
  ]);

  const packageJson = await readPackageJson();
  await buildServer({
    packageJson,
    isProduction,
    outputBuildFolder,
    appProcess,
  });

  return fsExtra.writeFile(`${outputBuildFolder}/server/config.json`, JSON.stringify(config, null, 2));
}
