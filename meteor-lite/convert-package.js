import fs from 'fs/promises';

import { convertPackage, packageMap } from './convert-meteor-package-to-npm.js';

export default async function convertPackageToNodeModule({
  packageNames,
  outputDirectory,
  directories,
}) {
  await Promise.all(packageNames.map(packageName => convertPackage(packageName, outputDirectory, ...directories)));
  return Array.from(packageMap.keys());
}
