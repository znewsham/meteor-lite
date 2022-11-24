import path from 'path';
import fsExtra from 'fs-extra';
import rimraf from 'rimraf';
import util from 'util';
import generateServer from '../build-run/server/generate-server';
import generateWebBrowser from '../build-run/client/generate-web-browser';

const asyncRimraf = util.promisify(rimraf);
export default async function prodBuild({
  directory,
  archs,
  packageDirs = [],
}) {
  const absoluteDirectory = path.resolve(directory);
  await asyncRimraf(absoluteDirectory);
  await Promise.all(archs.map((arch) => generateWebBrowser(
    arch,
    {
      isProduction: true,
      outputBuildFolder: absoluteDirectory,
    },
  )));
  await generateServer(
    archs,
    {
      isProduction: true,
      outputBuildFolder: absoluteDirectory,
    },
  );
  await Promise.all([
    fsExtra.copyFile('package.json', path.join(directory, 'package.json')),
    fsExtra.copyFile('package-lock.json', path.join(directory, 'package-lock.json')),
    (async () => {
      if (await fsExtra.pathExists('.npmrc')) {
        await fsExtra.copyFile('.npmrc', path.join(directory, '.npmrc'));
      }
    })(),
    (async () => {
      if (await fsExtra.pathExists('meteor-peer-dependencies/package.json')) {
        await fsExtra.copy('meteor-peer-dependencies', path.join(directory, 'meteor-peer-dependencies'));
      }
    })(),
    ...packageDirs.map((dir) => fsExtra.copy(dir, path.join(directory, dir))),
  ]);
}
