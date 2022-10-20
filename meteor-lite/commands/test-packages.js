import fs from 'fs-extra';
import { readPackageJson } from './helpers/command-helpers';
import { getFinalPackageListForArch } from './helpers/final-package-list';
import { meteorNameToNodeName } from '../helpers/helpers';

// it's possible these should just be handled by the existing extraPackages argument.
const staticImports = [
  // uggggh - this just has to be first, so annoying
  'meteor',
  // required for auto-refresh on file change
  'hot-code-push',
  // required for meteor shell
  'shell-server',
];

function dependenciesToString(packages) {
  return packages.map(({ nodeName, isLazy }) => {
    if (isLazy) {
      return `import "${nodeName}/__defineOnly.js";`;
    }
    return `import "${nodeName}";`;
  }).join('\n');
}

export default async function testPackages({ directory, packages, driverPackage, extraPackages = [] }) {
  process.chdir(directory);
  const packageJson = await readPackageJson();
  const { client: clientMain, server: serverMain } = packageJson.meteor.mainModule;

  // TODO: remove hardcoded package.json - maybe instead can use require.resolve or similar to just grab the package.json
  const allPackages = [
    ...staticImports,
    ...packages,
    ...extraPackages,
    driverPackage,
  ];

  const underTestString = packages.map((packageName) => `import "${meteorNameToNodeName(packageName)}/__test.js";`).join('\n');
  const serverPackages = await getFinalPackageListForArch(allPackages, 'server');
  const clientPackages = await getFinalPackageListForArch(allPackages, 'client');
  await fs.writeFile(
    clientMain,
    `${dependenciesToString(clientPackages)}\n${underTestString}\nrunTests();`,
  );

  await fs.writeFile(
    serverMain,
    `${dependenciesToString(serverPackages)}\n${underTestString}`,
  );
}
