import esbuild from 'esbuild';
import fsExtra from 'fs-extra';
import fs from 'fs/promises';
import path from 'path';
import _ from 'underscore';
import {
  baseFolder, ensureBuildDirectory, readPackageJson, listFilesInDir,
} from './command-helpers.js';

// TODO - remove this
const nodeModulePrefixesToWatch = [
  '@meteor',
  '@qualia',
];

const staticPath = path.join(path.dirname(import.meta.url), '..', '..', 'static').replace('file:', '');

function queueForBuild(buildRoot, queue) {
  return {
    name: 'queue-for-build',
    async setup(build) {
      // even though we only care about ts/js files - if we don't include all files, imported node modules get rewritten weirdly
      build.onResolve({ filter: /.*/ }, async ({ kind, path: filePath, resolveDir }) => {
        const watchFiles = [];
        const watchDirs = [];
        const watchingPrefix = nodeModulePrefixesToWatch.find((prefix) => filePath.startsWith(prefix));
        if (kind === 'entry-point') {
          return {
            path: path.resolve(path.join(buildRoot, filePath)),
            watchFiles,
            watchDirs,
          };
        }
        if ((!filePath.startsWith('.') && !filePath.startsWith('/')) && !watchingPrefix) {
          return {
            external: true,
            watchFiles,
            watchDirs,
          };
        }
        if (watchingPrefix) {
          let resolved = (await build.resolve(`node_modules/${filePath}`, { resolveDir })).path;

          // eslint-disable-next-line
          while (!await fsExtra.pathExists(resolved) && !resolved.endsWith('/node_modules/')) {
            resolved = resolved.split('/').slice(0, -1).join('/');
          }
          const stats = await fs.lstat(resolved);
          if (stats.isSymbolicLink()) {
            watchDirs.push(resolved);
            const files = await listFilesInDir(resolved);
            watchFiles.push(...files);
          }
        }
        else {
          queue.push(path.join(resolveDir.replace(`${buildRoot}/`, ''), filePath));
        }
        return {
          external: true,
          watchFiles,
          watchDirs,
        };
      });
    },
  };
}

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
