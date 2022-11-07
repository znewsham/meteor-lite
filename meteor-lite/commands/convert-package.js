import ConversionJob from '../conversion/conversion-job.js';

export default async function convertPackageToNodeModule({
  packageNames,
  outputDirectory: outputGeneralDirectory,
  directories: otherPackageFolders,
  meteorInstall,
  forceRefresh,
}) {
  const job = new ConversionJob({
    outputGeneralDirectory,
    otherPackageFolders,
    meteorInstall,
    options: {
      forceRefresh,
    },
  });
  console.log(packageNames);
  await Promise.all(packageNames.map((meteorName) => job.convertPackage(meteorName)));
  return Array.from(job.convertedPackageNames());
}
