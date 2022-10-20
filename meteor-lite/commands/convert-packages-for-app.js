import fs from 'fs/promises';

import { baseFolder, generateGlobals } from '../helpers/command-helpers.js';
import { convertPackage, packageMap } from '../convert-meteor-package-to-npm.js';
import { meteorNameToNodeName, nodeNameToMeteorName } from '../helpers/helpers.js';
import { getFinalPackageListForArch } from '../helpers/final-package-list';

const archsToConditions = {
  'web.browser': 'Meteor.isModern',
  'web.browser.legacy': '!Meteor.isModern',
};
// TODO: arch we shouldn't enforce that client lives in the client folder.
export async function updateDependenciesForArch(outputDirectory, actualPackages, arch) {
  const { map, conditionalMap } = await generateGlobals(outputDirectory, actualPackages.map(({ nodeName }) => nodeNameToMeteorName(nodeName)), arch);
  await fs.writeFile(`./${arch}/dependencies.js`, Array.from(map.entries()).map(([packageName, globals], i) => {
    const nodeName = meteorNameToNodeName(packageName);
    if (!globals.size && !conditionalMap.has(packageName)) {
      return `import "${nodeName}";`;
    }
    const imp = `import * as __package_${i} from "${nodeName}";`;
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
      ...Array.from(globals).map((global) => `globalThis.${global} = __package_${i}.${global}`),
      ...conditionals,
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
