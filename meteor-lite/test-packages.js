import fs from 'fs-extra';
import { readPackageJson } from './helpers/command-helpers';
import { meteorNameToNodeName } from './helpers/helpers';

// hacky fix for issue with underscore loading meteor CJS before something loads meteor ESM.
const staticImports = 'import "@meteor/meteor"\n';

export default async function testPackages({ directory, packages, driverPackage }) {
  process.chdir(directory);
  const packageJson = await readPackageJson();
  const { client: clientMain, server: serverMain } = packageJson.meteor.mainModule;

  // TODO: remove hardcoded package.json - maybe instead can use require.resolve or similar to just grab the package.json

  const dependencies = await packages.map((aPackage) => {
    if (aPackage.startsWith('@')) {
      return aPackage;
    }
    return meteorNameToNodeName(aPackage);
  }).map((aPackage) => `import "${aPackage}/__test.js"`).join('\n');

  await fs.writeFile(
    clientMain,
    `${staticImports}${dependencies}\nimport "${driverPackage}";\nrunTests();`,
  );

  await fs.writeFile(
    serverMain,
    `${staticImports}${dependencies}\nimport "${driverPackage}";`,
  );
}
