import fs from 'fs-extra';
import path from 'path';
import { generateGlobals } from './helpers/command-helpers';
import { getFinalPackageListForArch } from './helpers/final-package-list';
import { meteorNameToNodeName } from '../helpers/helpers';
import convertPackagesToNodeModulesForApp from './convert-packages-for-app';
import npmInstall from './helpers/npm-install';
import dependencyEntry from './helpers/dependency-entry';
import writePeerDependencies from './write-peer-dependencies';
import tmp from 'tmp';
import { TestSuffix } from '../conversion/meteor-package';

// it's possible these should just be handled by the existing extraPackages argument.
const staticImports = [
  // uggggh - this just has to be first, so annoying
  'meteor',
  // required for auto-refresh on file change
  'hot-code-push',
  // required for meteor shell
  'shell-server',
];

function dependenciesToString(nodePackagesVersionsAndExports, clientOrServer) {
  const { map, conditionalMap } = generateGlobals(nodePackagesVersionsAndExports, clientOrServer);

  const importsToWrite = [];
  const globalsToWrite = [];
  nodePackagesVersionsAndExports.forEach(({ nodeName, isLazy, onlyLoadIfProd }, i) => {
    const { importToWrite, globalToWrite } = dependencyEntry({
      nodeName,
      isLazy,
      onlyLoadIfProd,
      globalsMap: map,
      conditionalMap,
      importSuffix: i,
    });
    if (importToWrite) {
      importsToWrite.push(importToWrite);
    }
    if (globalToWrite) {
      globalsToWrite.push(globalToWrite);
    }
  });
  return [...importsToWrite, ...globalsToWrite].filter(Boolean).join('\n');
}

async function initProjectDirectory(testDirectory) {
  const directoryObj = testDirectory ? { name: testDirectory } : tmp.dirSync({
    unsafeCleanup: true,
  });
  const directory = directoryObj.name;
  const packageJsonPath = path.join(directory, 'package.json');
  const mainClientPath = 'client/main.js';
  const mainServerPath = 'server/main.js';
  await fs.ensureDir(directory);
  if (await fs.pathExists('.npmrc')) {
    await fs.copyFile('.npmrc', path.join(directory, '.npmrc'));
  }
  await Promise.all([
    fs.ensureDir(path.join(directory, 'client')),
    fs.ensureDir(path.join(directory, 'server')),
    fs.ensureDir(path.join(directory, '.meteor')),
  ]);

  // NOTE: this is hacky - we should move to allowing these to be read from package.json
  await fs.writeFile(path.join(directory, '.meteor', 'release'), '');
  await fs.writeFile(path.join(directory, '.meteor', '.id'), '');
  const packageJson = {
    name: 'meteor-test-packages',
    type: 'module',
    dependencies: {
      jquery: '3.6.1',
      fibers: 'git+https://github.com/qualialabs/node-fibers.git#d6788269d7886bc1d4a4d287bc59a3e1cc93779b',
      'meteor-node-stubs': '1.2.5',
    },
    meteor: {
      mainModule: {
        client: mainClientPath,
        server: mainServerPath,
      },
    },
  };
  await fs.writeFile(
    packageJsonPath,
    JSON.stringify(packageJson, null, 2),
  );
  const outputDirectory = path.resolve(path.join(directory, 'npm-packages'));
  process.chdir(directory);
  return { packageJson, outputDirectory };
}

export default async function buildAppForTestPackages({
  packages,
  directories,
  driverPackage,
  extraPackages = [],
  meteorInstall,
  testDirectory,
}) {
  const absoluteMeteorInstall = path.resolve(meteorInstall);
  const absoluteDirectories = directories.map((dir) => path.resolve(dir));
  const { packageJson, outputDirectory } = await initProjectDirectory(testDirectory);
  const { client: clientMain, server: serverMain } = packageJson.meteor.mainModule;

  let allPackages = [
    ...staticImports,
    ...packages.map((meteorName) => `${meteorName}${TestSuffix}`),
    ...extraPackages,
    driverPackage,
  ];

  // we need to use absolute directories because the chdir could be anywhere
  const job = await convertPackagesToNodeModulesForApp({
    appPackagesOverride: allPackages,
    outputDirectory,
    directories: absoluteDirectories,
    updateDependencies: false, // we'll handle our own dependencies
    meteorInstall: absoluteMeteorInstall,
    forceRefresh: new Set([...packages, ...extraPackages]),
  });
  allPackages = allPackages.map((meteorName) => (meteorName.endsWith(TestSuffix) ? meteorName.replace(TestSuffix, '') : meteorName));

  const underTestString = packages.map((packageName) => `import "${meteorNameToNodeName(packageName)}/__test.js";`).join('\n');

  const underTest = new Set(packages);
  const nodePackagesAndVersions = allPackages.map((meteorName) => {
    const nodeName = meteorNameToNodeName(meteorName);
    const { version } = job.get(meteorName);
    return {
      nodeName,
      version,
      evaluateTestPackage: underTest.has(meteorName),
    };
  });

  const localDirs = [
    outputDirectory,
  ].filter(Boolean);

  await writePeerDependencies({ name: 'meteor-peer-dependencies', nodePackagesAndVersions, localDirs });
  await npmInstall();

  const serverPackages = await getFinalPackageListForArch(nodePackagesAndVersions, 'server', localDirs);
  const clientPackages = await getFinalPackageListForArch(nodePackagesAndVersions, 'client', localDirs);
  await fs.writeFile(
    clientMain,
    `${dependenciesToString(clientPackages, 'client')}\n${underTestString}\nrunTests();`,
  );

  await fs.writeFile(
    serverMain,
    `${dependenciesToString(serverPackages, 'server')}\n${underTestString}`,
  );

  return job;
}
