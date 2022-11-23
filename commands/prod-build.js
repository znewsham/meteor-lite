import path from 'path';
import generateServer from '../build-run/server/generate-server';
import generateWebBrowser from '../build-run/client/generate-web-browser';

export default async function prodBuild({ directory, archs }) {
  const absoluteDirectory = path.resolve(directory);
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
}
