import fs from 'fs-extra';
import path from 'path';

import { baseFolder, generateGlobals } from './helpers/command-helpers.js';
import { convertPackage, packageMap, warmPackage } from '../convert-meteor-package-to-npm.js';
import { meteorNameToNodeName, meteorNameToNodePackageDir, nodeNameToMeteorName } from '../helpers/helpers.js';
import { getFinalPackageListForArch } from './helpers/final-package-list';

const archsToConditions = {
  'web.browser': 'Meteor.isModern',
  'web.browser.legacy': '!Meteor.isModern',
};
// TODO: arch we shouldn't enforce that client lives in the client folder.
// TODO: this is a mess, the combo of lazy, production and conditional (per-arch) exports
export async function updateDependenciesForArch(outputDirectory, actualPackages, arch) {
  const { map, conditionalMap } = await generateGlobals(outputDirectory, actualPackages.map(({ nodeName }) => nodeNameToMeteorName(nodeName)), arch);
  await fs.writeFile(`./${arch}/dependencies.js`, actualPackages.map(({ nodeName, isLazy, onlyLoadIfProd }, i) => {
    if (isLazy) {
      return '';
    }
    const packageName = nodeNameToMeteorName(nodeName);
    const globals = map.get(packageName);
    if (onlyLoadIfProd) {
      console.warn(`prod-only package ${packageName}, you need to add the correct conditional import yourself and add these if you expect the globals to be set. If you don't need the globals, no action is required`);
      return '';
    }
    const importName = onlyLoadIfProd ? `${nodeName.replace('@', '#').replace(/\//g, '_')}` : nodeName;
    if ((!globals || !globals.size) && !conditionalMap.has(packageName)) {
      return `import "${importName}";`;
    }
    const imp = `import * as __package_${i} from "${importName}";`;
    const conditionals = [];
    if (conditionalMap.has(packageName)) {
      const conditionalsForPackage = conditionalMap.get(packageName);
      Array.from(conditionalsForPackage.entries()).forEach(([archName, exp]) => {
        conditionals.push([
          `if (${archsToConditions[archName]}) {`,
          ...exp.map((global) => `globalThis.${global} = __package_${i}.${global}`),
          '}',
        ].join('\n'));
      });
    }
    return [
      imp,
      ...(onlyLoadIfProd ? ['if (Meteor.isProduction) {'] : []),
      ...Array.from(globals).map((global) => `globalThis.${global} = __package_${i}.${global}`),
      ...conditionals,
      ...(onlyLoadIfProd ? ['}'] : []),
    ].join('\n');
  }).join('\n'));
}

export default async function convertPackagesToNodeModulesForApp({
  extraPackages,
  outputDirectory: outputParentFolder,
  directories: otherPackageFolders,
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

  // TODO: apply version constraints from `${baseFolder}/packages`
  const appVersions = (await fs.readFile(`${baseFolder}/packages`))
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
  await Promise.all(appVersions.map((meteorNameAndVersionConstraint) => warmPackage({
    meteorName: meteorNameAndVersionConstraint,
    outputParentFolder,
    options,
  })));

  const allPackages = Array.from(new Set([
    ...appPackages,
    ...extraPackages,
  ]));
  await Promise.all(allPackages.map((meteorNameAndMaybeVersionConstraint) => convertPackage({
    meteorName: meteorNameAndMaybeVersionConstraint,
    meteorInstall,
    outputParentFolder,
    otherPackageFolders,
    options,
  })));
  const actualPackages = appPackages
    .map((nameAndMaybeVersion) => nameAndMaybeVersion.split('@')[0])
    .filter((name) => packageMap.has(name));
  const packageJsonEntries = Object.fromEntries(await Promise.all(actualPackages.map(async (meteorName) => {
    const folderPath = path.join(outputParentFolder, meteorNameToNodePackageDir(meteorName));
    return [
      meteorNameToNodeName(meteorName),
      await fs.pathExists(folderPath) ? `file:${folderPath}` : packageMap.get(meteorName).version,
    ];
  })));

  const packageJson = JSON.parse((await fs.readFile('./package.json')).toString());
  packageJson.dependencies = Object.fromEntries(Object.entries({
    ...packageJson.dependencies,
    ...packageJsonEntries,
  }).sort(([a], [b]) => a.localeCompare(b)));
  await fs.writeFile('./package.json', JSON.stringify(packageJson, null, 2));
  // TODO: await write-peer-dependencies
  // TODO: maybe await npmInstall(actualPackages);
  const serverPackages = await getFinalPackageListForArch(actualPackages, 'server');
  const clientPackages = await getFinalPackageListForArch(actualPackages, 'client');

  if (updateDependencies) {
    await Promise.all([
      updateDependenciesForArch(outputParentFolder, serverPackages, 'client'),
      updateDependenciesForArch(outputParentFolder, clientPackages, 'server'),
    ]);
  }
  return allPackages;
}
