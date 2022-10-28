import fs from 'fs/promises';
import path from 'path';

import { baseFolder, generateGlobals } from './helpers/command-helpers.js';
import { convertPackage, packageMap } from '../convert-meteor-package-to-npm.js';
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
  const appPackages = (await fs.readFile(`${baseFolder}/packages`))
    .toString()
    .split('\n')
    .map((line) => line.split('@')[0].split('#')[0].trim())
    .filter(Boolean);

  const allPackages = Array.from(new Set([
    ...appPackages,
    ...extraPackages,
  ]));
  await Promise.all(allPackages.map((meteorName) => convertPackage({
    meteorName,
    meteorInstall,
    outputParentFolder,
    otherPackageFolders,
    options: {
      forceRefresh,
    },
  })));
  const actualPackages = appPackages.filter((name) => packageMap.has(name));
  const packageJsonEntries = Object.fromEntries(actualPackages.map((meteorName) => [
    meteorNameToNodeName(meteorName),
    `file:${path.join(outputParentFolder, meteorNameToNodePackageDir(meteorName))}`,
  ]));

  const packageJson = JSON.parse((await fs.readFile('./package.json')).toString());
  packageJson.dependencies = Object.fromEntries(Object.entries({
    ...packageJson.dependencies,
    ...packageJsonEntries,
  }).sort(([a], [b]) => a.localeCompare(b)));
  await fs.writeFile('./package.json', JSON.stringify(packageJson, null, 2));
  // TODO: await npmInstall(actualPackages);

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
