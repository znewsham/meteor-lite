import fs from 'fs-extra';
import ConversionJob from '../conversion/conversion-job.js';
import { baseFolder } from '../helpers/base-folder';

export default async function convertPackageToNodeModule({
  packageNames,
  outputDirectory: outputGeneralDirectory,
  directories: otherPackageFolders,
  meteorInstall,
  outputSharedDirectory,
  outputLocalDirectory,
  forceRefresh,
}) {
  const job = new ConversionJob({
    outputGeneralDirectory,
    outputSharedDirectory,
    outputLocalDirectory,
    otherPackageFolders,
    meteorInstall,
    options: {
      forceRefresh,
    },
  });
  const versionsPath = `${baseFolder}/versions`;
  let versions = [];
  if (await fs.pathExists(versionsPath)) {
    versions = (await fs.readFile(`${baseFolder}/versions`))
      .toString()
      .split('\n')
      .map((line) => line.split('#')[0].trim())
      .filter(Boolean);
  }
  await job.convertPackages(packageNames, versions);
  return Array.from(job.convertedPackageNames());
}
