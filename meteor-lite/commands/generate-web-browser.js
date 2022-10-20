import _generateWebBrowser from './helpers/generate-web-browser.js';
import { baseBuildFolder } from './helpers/command-helpers.js';

export default async function generateWebBrowser(
  archName,
  {
    appProcess,
    isProduction = false,
    outputBuildFolder = baseBuildFolder,
  } = {},
) {
  return _generateWebBrowser(archName, { appProcess, isProduction, outputBuildFolder });
}
