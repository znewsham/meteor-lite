import { convertPackage, packageMap } from './convert-meteor-package-to-npm.js';

export default async function convertPackageToNodeModule({
  packageNames,
  outputDirectory,
  directories,
  meteorInstall,
}) {
  await Promise.all(packageNames.map((packageName) => convertPackage(packageName, meteorInstall, outputDirectory, ...directories)));
  return Array.from(packageMap.keys());
}
