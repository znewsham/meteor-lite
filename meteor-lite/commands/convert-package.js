import ConversionJob from '../conversion/conversion-job.js';

export default async function convertPackageToNodeModule({
  packageNames,
  outputDirectory: outputParentFolder,
  directories: otherPackageFolders,
  meteorInstall,
  forceRefresh,
}) {
  const job = new ConversionJob({
    generalOutputDirectory: outputParentFolder,
    otherPackageFolders,
    meteorInstall,
    options: {
      forceRefresh,
    },
  });
  await Promise.all(packageNames.map((meteorName) => job.convertPackage(meteorName)));
  return Array.from(job.convertedPackageNames());
}
