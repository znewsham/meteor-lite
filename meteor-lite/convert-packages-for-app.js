import fs from 'fs/promises';

import { baseFolder, generateGlobals } from './helpers/command-helpers.js';
import { convertPackage, packageMap } from './convert-meteor-package-to-npm.js';
import { nodeNameToMeteorName } from './helpers/helpers.js';

async function updateDependenciesForArch(actualPackages, arch) {
  const map = await generateGlobals(actualPackages.map((dep) => nodeNameToMeteorName(dep)), arch);
  await fs.writeFile(`./${arch}/dependencies.js`, Array.from(map.entries()).map(([packageName, globals], i) => {
    if (!globals.size) {
      return `import "${packageName}";`;
    }
    const imp = `import * as __package_${i} from "${packageName}";`;
    return [
      imp,
      ...Array.from(globals).map((global) => `globalThis.${global} = __package_${i}.${global}`),
    ].join('\n');
  }).join('\n'));
}

export default async function convertPackagesToNodeModulesForApp({
  extraPackages,
  outputDirectory,
  directories,
  updateDependencies,
  meteorInstall,
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
  await Promise.all(allPackages.map((packageName) => convertPackage(packageName, meteorInstall, outputDirectory, ...directories)));
  const actualPackages = appPackages.filter((name) => packageMap.has(name));

  if (updateDependencies) {
    await Promise.all([
      updateDependenciesForArch(actualPackages, 'client'),
      updateDependenciesForArch(actualPackages, 'server'),
    ]);
  }
  return actualPackages;
}
