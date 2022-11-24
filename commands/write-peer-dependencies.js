import fs from 'fs-extra';
import { ExcludePackageNames } from '../constants';
import { meteorNameToNodeName } from '../helpers/helpers';
import calculateVersions from './helpers/calculate-versions';

export default async function writePeerDependencies({
  name,
  nodePackagesAndVersions,
  localDirs,
  dependenciesKey = 'dependencies',
  usePeer = true,
}) {
  const packageJson = JSON.parse((await fs.readFile('./package.json')).toString());
  let meteorPackageNamesMaybeWithVersions = nodePackagesAndVersions;
  if (!nodePackagesAndVersions && await fs.pathExists('.meteor/packages')) {
    meteorPackageNamesMaybeWithVersions = (await fs.readFile('.meteor/packages')).toString()
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .map((line) => line.split('#')[0])
      .map((line) => line.trim())
      .filter(Boolean)
      .map((nameAndMaybeVersion) => {
        const [meteorName, version] = nameAndMaybeVersion.split('@');
        if (ExcludePackageNames.has(meteorName)) {
          return undefined;
        }
        return {
          nodeName: meteorNameToNodeName(meteorName),
          version,
        };
      })
      .filter(Boolean);
  }
  else if (!nodePackagesAndVersions) {
    meteorPackageNamesMaybeWithVersions = Object.entries({ ...packageJson.dependencies, ...packageJson.optionalDependencies })
      .map(([nodeName, version]) => ({
        nodeName,
        version,
      }))
      .filter(({ nodeName }) => nodeName !== name)
      // NOTE: maybe figure out how to get this to play nice with github, I don't think we really care too much
      .filter(({ version }) => !version.startsWith('git'));
  }
  const directDependencies = new Set(meteorPackageNamesMaybeWithVersions.map(({ nodeName }) => nodeName));

  // TODO: make calculateVersions work with the meteor constraint solver.
  const { finalVersions, badVersions } = await calculateVersions(
    meteorPackageNamesMaybeWithVersions,
    localDirs,
  );
  const ret = {
    name,
    version: '1.0.0',
    dependencies: {},
  };
  if (badVersions.length) {
    console.log(badVersions);
    throw new Error('bad versions');
  }
  Object.entries(finalVersions).forEach(([depName, version]) => {
    if (!packageJson[dependenciesKey][depName] || version.startsWith('file:')) {
      if (!usePeer || version.startsWith('file:') || directDependencies.has(depName)) {
        packageJson[dependenciesKey][depName] = version;
        delete finalVersions[depName];
      }
      else {
        ret.dependencies[depName] = version;
      }
    }
    else {
      delete finalVersions[depName];
    }
  });

  ret.dependencies = Object.fromEntries(Object.entries(ret.dependencies).sort(([aName], [bName]) => aName.localeCompare(bName)));
  packageJson[dependenciesKey] = Object.fromEntries(Object.entries(packageJson[dependenciesKey]).sort(([aName], [bName]) => aName.localeCompare(bName)));
  if (usePeer && Object.keys(ret.dependencies).length) {
    await fs.ensureDir(name);
    await fs.writeFile(`./${name}/package.json`, JSON.stringify(ret, null, 2));
    packageJson[dependenciesKey][name] = `file:${name}`;
  }
  return fs.writeFile('./package.json', JSON.stringify(packageJson, null, 2));
}
