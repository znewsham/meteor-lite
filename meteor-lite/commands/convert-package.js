import { convertPackage, packageMap } from '../convert-meteor-package-to-npm.js';

export default async function convertPackageToNodeModule({
  packageNames,
  outputDirectory: outputParentFolder,
  directories: otherPackageFolders,
  meteorInstall,
  forceRefresh,
}) {
  await Promise.all(packageNames.map((meteorName) => convertPackage({
    meteorName,
    meteorInstall,
    outputParentFolder,
    otherPackageFolders,
    options: {
      forceRefresh,
    },
  })));
  return Array.from(packageMap.keys());
}
