import { program } from 'commander';
import os from 'os';
import generateWebBrowser from './generate-web-browser.js';
import generateServer from './generate-server.js';
import convertPackagesToNodeModulesForApp from './convert-packages-for-app.js';
import convertPackageToNodeModule from './convert-package.js';
import run from './dev-run.js';
import generateMain from './build-main.js';

program
  .version('0.1.0')
  .command('generate-web-browser')
  .action(async () => {
    console.log(await generateWebBrowser());
  });

program
  .command('dev-build')
  .action(async () => {
    await generateWebBrowser();
    await generateServer(['web.browser']);
  });

program
  .command('dev-run')
  .action(async () => {
    let start = new Date().getTime();
    await generateWebBrowser();
    let end = new Date().getTime();
    console.log("web browser", end - start);
    start = end;
    await generateServer(['web.browser']);
    end = new Date().getTime();
    console.log("server", end - start);
    await run();
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
  .option('-d, --directories <directories...>', 'the prioritized list of directories to search for packages')
  .option('-o, --outputDirectory <outputDirectory>', 'the output directory')
  .option('-u, --update', 'update the dependencies.js file?')
  .option('-m, --meteor <meteorInstall>', 'path to the meteor install')
  .action(async ({
    packages = [], directories, outputDirectory, update, meteor
  }) => {
    if (!directories) {
      throw new Error('must specify search directories');
    }
    if (!outputDirectory) {
      throw new Error('must specify output directory');
    }
    console.log(await convertPackagesToNodeModulesForApp({
      extraPackages: packages,
      outputDirectory,
      directories,
      updateDependencies: update,
      meteorInstall: meteor || `${os.homedir()}/.meteor`,
    }));
  });

program
  .command('convert-packages')
  .option('-p, --packages <package...>', 'the packages to convert')
  .option('-d, --directories <directories...>', 'the prioritized list of directories to search for packages')
  .option('-o, --outputDirectory <outputDirectory>', 'the output directory')
  .option('-m, --meteor <meteorInstall>', 'path to the meteor install')
  .action(async ({ packages: packageNames, directories, outputDirectory, meteor }) => {
    if (!outputDirectory) {
      throw new Error('must specify output directory');
    }
    console.log(await convertPackageToNodeModule({
      packageNames,
      outputDirectory,
      directories: directories || [],
      meteorInstall: meteor || `${os.homedir()}/.meteor`,
    }));
  });

program.parseAsync().catch(console.error);
