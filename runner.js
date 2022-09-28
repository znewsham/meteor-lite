import { program } from 'commander';
import generateWebBrowser from './generate-web-browser.js';
import generateServer from './generate-server.js';
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

program.parseAsync().catch(console.error);
