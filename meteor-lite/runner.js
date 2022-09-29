import { program } from 'commander';
import generateWebBrowser from './generate-web-browser.js';
import generateServer from './generate-server.js';
import convertPackagesToNodeModulesForApp from './convert-packages-for-app.js';
import convertPackageToNodeModule from './convert-package.js';
import run from './dev-run.js';

program
  .version('0.1.0')
  .command('generate-web-browser')
  .action(async function () {
    console.log(await generateWebBrowser());
  });

program
  .version('0.1.0')
  .command('dev-build')
  .action(async function () {
    await generateWebBrowser();
    await generateServer(['web.browser']);
  });

program
  .version('0.1.0')
  .command('dev-run')
  .action(async function () {
    await generateWebBrowser();
    await generateServer(['web.browser']);
    await run();
  });

program
  .version('0.1.0')
  .command('convert-deps')
  .option('-p, --packages [packages...]', 'any extra packages to convert')
  .option('-d, --directories <directories...>', 'the prioritized list of directories to search for packages')
  .option('-o, --outputDirectory <outputDirectory>', 'the output directory')
  .option('-u, --update', 'update the dependencies.js file?')
  .action(async function ({ packages = [], directories, outputDirectory, update }) {
    if (!directories) {
      throw new Error("must specify search directories");
    }
    if (!outputDirectory) {
      throw new Error("must specify output directory");
    }
    console.log(await convertPackagesToNodeModulesForApp({
      extraPackages: packages,
      outputDirectory, 
      directories,
      updateDependencies: update
    }));
  });

  program
    .version('0.1.0')
    .command('convert-packages')
    .option('-p, --packages <package...>', 'the packages to convert')
    .option('-d, --directories <directories...>', 'the prioritized list of directories to search for packages')
    .option('-o, --outputDirectory <outputDirectory>', 'the output directory')
    .action(async function ({ packages: packageNames, directories, outputDirectory }) {
      if (!directories) {
        throw new Error("must specify search directories");
      }
      if (!outputDirectory) {
        throw new Error("must specify output directory");
      }
      console.log(await convertPackageToNodeModule({
        packageNames,
        outputDirectory, 
        directories
      }));
    });

program.parseAsync().catch(console.error);
