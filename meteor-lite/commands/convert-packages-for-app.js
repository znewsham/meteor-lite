import fs from 'fs-extra';
import path from 'path';

import { baseFolder, generateGlobals } from './helpers/command-helpers.js';
import ConversionJob from '../conversion/conversion-job.js';
import { meteorNameToNodeName, meteorNameToNodePackageDir } from '../helpers/helpers.js';
import { getFinalPackageListForArch } from './helpers/final-package-list';
import MeteorPackage from '../conversion/meteor-package.js';
import writePeerDependencies from './write-peer-dependencies.js';
import { warn } from '../helpers/log.js';

const archsToConditions = {
  'web.browser': 'Meteor.isModern',
  'web.browser.legacy': '!Meteor.isModern',
};
// TODO: arch we shouldn't enforce that client lives in the client folder.
// TODO: this is a mess, the combo of lazy, production and conditional (per-arch) exports
export async function updateDependenciesForArch(nodePackagesVersionsAndExports, clientOrServer) {
  const { map, conditionalMap } = generateGlobals(nodePackagesVersionsAndExports, clientOrServer);

  const importsToWrite = [];
  const globalsToWrite = [];
  nodePackagesVersionsAndExports.forEach(({ nodeName, isLazy, onlyLoadIfProd }, i) => {
    if (isLazy) {
      return;
    }
    const globals = map.get(nodeName);
    if (onlyLoadIfProd) {
      warn(`prod-only package ${nodeName}, you need to add the correct conditional import yourself and add these if you expect the globals to be set. If you don't need the globals, no action is required`);
      return;
    }
    const importName = onlyLoadIfProd ? `${nodeName.replace('@', '#').replace(/\//g, '_')}` : nodeName;
    if ((!globals || !globals.size) && !conditionalMap.has(nodeName)) {
      importsToWrite.push(`import "${importName}";`);
      return;
    }
    const imp = `import * as __package_${i} from "${importName}";`;
    const conditionals = [];
    if (conditionalMap.has(nodeName)) {
      const conditionalsForPackage = conditionalMap.get(nodeName);
      Array.from(conditionalsForPackage.entries()).forEach(([archName, exp]) => {
        conditionals.push([
          `if (${archsToConditions[archName]}) {`,
          ...exp.map((global) => `globalThis.${global} = __package_${i}.${global}`),
          '}',
        ].join('\n'));
      });
    }
    importsToWrite.push(imp);
    globalsToWrite.push([
      ...(onlyLoadIfProd ? ['if (Meteor.isProduction) {'] : []),
      ...Array.from(globals).map((global) => `globalThis.${global} = __package_${i}.${global}`),
      ...conditionals,
      ...(onlyLoadIfProd ? ['}'] : []),
    ].join('\n'));
  });
  await fs.writeFile(`./${clientOrServer}/dependencies.js`, [...importsToWrite, ...globalsToWrite].filter(Boolean).join('\n'));
}

export default async function convertPackagesToNodeModulesForApp({
  extraPackages = [],
  outputDirectory: outputGeneralDirectory,
  directories: otherPackageFolders = [],
  outputSharedDirectory,
  outputLocalDirectory,
  updateDependencies,
  meteorInstall,
  forceRefresh,
}) {
  // by using versions instead of packages we'll enforce converting the exact versions of every package
  // but it also means we're gonna look at every package - not just "ours" + lazily their dependencies
  const appPackages = (await fs.readFile(`${baseFolder}/packages`))
    .toString()
    .split('\n')
    .map((line) => line.split('#')[0].trim())
    .filter(Boolean);

  const appVersions = (await fs.readFile(`${baseFolder}/versions`))
    .toString()
    .split('\n')
    .map((line) => line.split('#')[0].trim())
    .filter(Boolean);

  const options = {
    forceRefresh,
    skipNonLocalIfPossible: true,
    // TODO: this assumes ./packages and ./.common are first - we should instead make this an option
    localPackageFolders: otherPackageFolders.slice(0, 2),
  };

  const job = new ConversionJob({
    outputGeneralDirectory,
    outputSharedDirectory,
    outputLocalDirectory,
    otherPackageFolders,
    meteorInstall,
    options,
  });
  appVersions.forEach((meteorNameAndVersionConstraint) => job.warmPackage(meteorNameAndVersionConstraint));

  const outputFolderMapping = {
    [MeteorPackage.Types.ISO]: outputGeneralDirectory,
    [MeteorPackage.Types.OTHER]: outputGeneralDirectory,
    [MeteorPackage.Types.LOCAL]: outputLocalDirectory || outputGeneralDirectory,
    [MeteorPackage.Types.SHARED]: outputSharedDirectory || outputGeneralDirectory,
  };

  const allPackages = Array.from(new Set([
    ...appPackages,
    ...extraPackages,
  ]));
  await Promise.all(allPackages.map((meteorNameAndMaybeVersionConstraint) => job.convertPackage(meteorNameAndMaybeVersionConstraint)));
  const actualPackages = appPackages
    .map((nameAndMaybeVersion) => nameAndMaybeVersion.split('@')[0])
    .filter((name) => job.has(name));
  const packageJsonEntries = Object.fromEntries(await Promise.all(actualPackages.map(async (meteorName) => {
    const outputDirectory = job.get(meteorName).outputParentFolder(outputFolderMapping);
    const folderPath = path.join(outputDirectory, meteorNameToNodePackageDir(meteorName));
    return [
      meteorNameToNodeName(meteorName),
      await fs.pathExists(folderPath) ? `file:${folderPath}` : job.get(meteorName).version,
    ];
  })));

  const packageJson = JSON.parse((await fs.readFile('./package.json')).toString());
  packageJson.dependencies = Object.fromEntries(Object.entries({
    ...packageJson.dependencies,
    ...packageJsonEntries,
  }).sort(([a], [b]) => a.localeCompare(b)));
  await fs.writeFile('./package.json', JSON.stringify(packageJson, null, 2));
  await writePeerDependencies({ name: 'meteor-peer-dependencies' });
  const nodePackagesAndVersions = actualPackages.map((meteorName) => {
    const nodeName = meteorNameToNodeName(meteorName);
    const { version } = job.get(meteorName);
    return {
      nodeName,
      version,
    };
  });

  const [serverPackages, clientPackages] = await Promise.all([
    getFinalPackageListForArch(nodePackagesAndVersions, 'server'),
    getFinalPackageListForArch(nodePackagesAndVersions, 'client'),
  ]);

  if (updateDependencies) {
    await Promise.all([
      updateDependenciesForArch(serverPackages, 'client'),
      updateDependenciesForArch(clientPackages, 'server'),
    ]);
  }
  return job;
}
