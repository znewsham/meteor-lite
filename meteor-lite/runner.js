#!/usr/bin/env -S node --experimental-specifier-resolution=node
import { program } from 'commander';
import os from 'os';
import path from 'path';
import fs from 'fs';
import generateWebBrowser from './commands/generate-web-browser.js';
import generateServer from './commands/generate-server.js';
import convertPackagesForApp from './commands/convert-packages-for-app.js';
import convertPackage from './commands/convert-package.js';
import testPackages from './commands/test-packages.js';
import run from './commands/dev-run.js';
import generateMain from './commands/build-main.js';
import prodBuild from './commands/prod-build.js';
import connect from './commands/shell-client.js';
import writePeerDependencies from './commands/write-peer-dependencies.js';
import { baseBuildFolder } from './commands/helpers/command-helpers.js';
import ensureLocalPackage from './commands/ensure-local-package.js';
import { error as logError } from './helpers/log';

const DefaultArchs = [
  'web.browser',
  'web.browser.legacy',
];

const packageJsonPath = path.join(path.dirname(import.meta.url.replace('file://', '')), 'package.json');
const packageJSON = JSON.parse(fs.readFileSync(packageJsonPath).toString());

program
  .version(packageJSON.version)
  .command('generate-web-browser')
  .action(async () => {
    await Promise.all(DefaultArchs.map((archName) => generateWebBrowser(archName)));
  });

program
  .command('dev-build')
  .action(async () => {
    await Promise.all(DefaultArchs.map((archName) => generateWebBrowser(archName)));
    await generateServer(DefaultArchs);
  });

program
  .command('dev-run')
  // You must have already built all the correct versions of the external dependencies
  // we won't re-gen the dependencies file
  .option('-w, --watch', 'build and watch the pacakges and .common directory?')
  .option('-m, --meteor <meteorInstall>', 'path to the meteor install')
  .option('-o, --outputDirectory <outputDirectory>', 'the output directory')
  .option('--outputLocalDirectory <outputLocalDirectory>', 'the output directory for packages in the packages directory')
  .option('--outputSharedDirectory <outputSharedDirectory>', 'the output directory for packages in the METEOR_PACKAGE_DIRS directory')
  .action(async ({
    watch: buildAndWatchPackages,
    outputSharedDirectory,
    outputDirectory,
    outputLocalDirectory,
    meteor,
  }) => {
    let job;
    if (buildAndWatchPackages) {
      if (!outputDirectory) {
        throw new Error('must specify output directory');
      }
      console.log('running in watch mode...building the local/shared packages');
      job = await convertPackagesForApp({
        extraPackages: [],
        directories: [],
        outputDirectory,
        outputSharedDirectory,
        outputLocalDirectory,
        meteorInstall: meteor || `${os.homedir()}/.meteor`,
      });
      console.log('build complete');
    }
    await run(DefaultArchs, { buildAndWatchPackages, job });
  });

program
  .command('build-main')
  .requiredOption('-e, --env <env>', 'which env (server or client)')
  .option('-u, --update', 'update the main.js file?')
  .action(async ({ env, update }) => {
    await generateMain({ env, update });
  });

program
  .command('convert-deps')
  .option('-p, --packages [packages...]', 'any extra packages to convert')
  .option('-d, --directories <directories...>', 'the prioritized list of additional directories to search for packages')
  .requiredOption('-o, --outputDirectory <outputDirectory>', 'the output directory')
  .option('--outputLocalDirectory <outputLocalDirectory>', 'the output directory for packages in the packages directory')
  .option('--outputSharedDirectory <outputSharedDirectory>', 'the output directory for packages in the METEOR_PACKAGE_DIRS directory')
  .option('-u, --update', 'update the dependencies.js file?')
  .option('-m, --meteor <meteorInstall>', 'path to the meteor install')
  .option('-f, --force-refresh', 'update all package dependencies, even if they\'re already converted')
  .action(async ({
    packages = [],
    directories,
    outputDirectory,
    outputSharedDirectory,
    outputLocalDirectory,
    update,
    meteor,
    forceRefresh,
  }) => {
    if (!outputDirectory) {
      throw new Error('must specify output directory');
    }
    await convertPackagesForApp({
      extraPackages: packages,
      outputDirectory,
      outputSharedDirectory,
      outputLocalDirectory,
      directories,
      updateDependencies: update,
      meteorInstall: meteor || `${os.homedir()}/.meteor`,
      forceRefresh,
    });

    // while you might think this line is superflous, it's very useful.
    // In some situations the conversion can deadlock in which case it exits with no output
    console.log('complete');
  });

program
  .command('convert-packages')
  .requiredOption('-p, --packages <package...>', 'the packages to convert')
  .requiredOption('-o, --outputDirectory <outputDirectory>', 'the output directory for general packages')
  .option('--outputLocalDirectory <outputLocalDirectory>', 'the output directory for packages in the packages directory')
  .option('--outputSharedDirectory <outputSharedDirectory>', 'the output directory for packages in the METEOR_PACKAGE_DIRS directory')
  .option('-m, --meteor <meteorInstall>', 'path to the meteor install')
  .option('-d, --directories <directories...>', 'the prioritized list of additional directories to search for packages')
  .option('-f, --force-refresh', 'update all package dependencies, even if they\'re already converted')
  .action(async ({
    packages: packageNames,
    directories,
    outputDirectory,
    outputSharedDirectory,
    outputLocalDirectory,
    meteor,
    forceRefresh,
  }) => {
    console.log(await convertPackage({
      packageNames,
      outputDirectory,
      outputSharedDirectory,
      outputLocalDirectory,
      directories: directories || [],
      meteorInstall: meteor || `${os.homedir()}/.meteor`,
      forceRefresh,
    }));
  });

program
  .command('test-packages')
  .requiredOption('-p, --packages <package...>', 'the packages to test')
  .requiredOption('-d, --directory <directory>', 'the directory to run the tests in - should have installed all the dependencies already')
  .option('-d, --extra-packages <extraPackages...>', 'any extra packages to load')
  .requiredOption('--driver-package <driverPackage>', 'the test driver to use')
  .action(async ({
    directory, packages, driverPackage, extraPackages,
  }) => {
    await testPackages({
      directory, packages, driverPackage, extraPackages,
    });
    await run(DefaultArchs);
  });

program
  .command('shell')
  .action(() => {
    const shellDir = process.env.METEOR_SHELL_DIR || path.resolve(path.join(baseBuildFolder, 'shell'));
    connect(shellDir);
  });

program
  .command('build')
  .requiredOption('-d, --directory <directory>', 'the output directory')
  .action(async ({
    directory,
  }) => {
    await prodBuild({
      directory,
      archs: DefaultArchs,
    });
  });

program
  .command('write-peer-dependencies')
  // .option('-n, --name <name>', 'the name of the local module to use', 'meteor-peer-dependencies')
  .action(async () => {
    await writePeerDependencies({ name: 'meteor-peer-dependencies' });
  });

program
  .command('ensure-local-package')
  .requiredOption('-n, --name <name>', 'the name of the package')
  .requiredOption('-v, --version <version>', 'the version of the package')
  .option('-m, --meteor <meteorInstall>', 'path to the meteor install')
  .action(async ({ name, version, meteor }) => {
    console.log(await ensureLocalPackage({ name, version, meteorInstall: meteor }));
  });

program.parseAsync().catch((err) => {
  logError('critical error, exiting');
  logError(err, err.stack);
  process.exit();
});
