import _generateWebBrowser from '../build-run/client/generate-web-browser';
import { baseBuildFolder } from '../helpers/base-folder';

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
