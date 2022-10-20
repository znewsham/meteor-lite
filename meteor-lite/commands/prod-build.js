import path from 'path';
import generateServer from './helpers/generate-server';
import generateWebBrowser from './helpers/generate-web-browser';

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
