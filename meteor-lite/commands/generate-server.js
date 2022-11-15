import { baseBuildFolder } from './helpers/command-helpers';
import _generateServer from '../build-run/server/generate-server';

export default async function generateServer(
  archs,
  {
    isProduction = false,
    outputBuildFolder = baseBuildFolder,
    appProcess,
  } = {},
) {
  return _generateServer(
    archs,
    {
      isProduction,
      outputBuildFolder,
      appProcess,
    },
  );
}
