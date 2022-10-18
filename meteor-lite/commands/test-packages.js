import fs from 'fs-extra';
import { readPackageJson } from '../helpers/command-helpers';
import { meteorNameToNodeName } from '../helpers/helpers';

const staticImports = [
  // hacky fix for issue with underscore loading meteor CJS before something loads meteor ESM.
  'import "@meteor/meteor";',
  // hacky fix until we figure out weak deps
  'import "@meteor/jquery";',
  // required for auto-refresh on file change
  'import "@meteor/hot-code-push";',
  // required for meteor shell
  'import "@meteor/shell-server";',
].join('\n');

export default async function testPackages({ directory, packages, driverPackage, extraPackages }) {
  process.chdir(directory);
  const packageJson = await readPackageJson();
  const { client: clientMain, server: serverMain } = packageJson.meteor.mainModule;

  // TODO: remove hardcoded package.json - maybe instead can use require.resolve or similar to just grab the package.json

  const dependencies = [
    ...packages.map((aPackage) => {
      if (aPackage.startsWith('@')) {
        return aPackage;
      }
      return meteorNameToNodeName(aPackage);
    }).map((aPackage) => `import "${aPackage}/__test.js"`),
    ...(extraPackages || []).map((aPackage) => {
      if (aPackage.startsWith('@')) {
        return aPackage;
      }
      return meteorNameToNodeName(aPackage);
    }).map((aPackage) => `import "${aPackage}"`),
  ].join('\n');

  await fs.writeFile(
    clientMain,
    `${staticImports}\n${dependencies}\nimport "${driverPackage}";\nrunTests();`,
  );

  await fs.writeFile(
    serverMain,
    `${staticImports}\n${dependencies}\nimport "${driverPackage}";`,
  );
}
