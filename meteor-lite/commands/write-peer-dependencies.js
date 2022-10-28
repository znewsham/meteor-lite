import fs from 'fs-extra';
import { ExcludePackageNames } from '../constants';
import { meteorNameToNodeName } from '../helpers/helpers';
import calculateVersions from './helpers/calculate-versions';

export default async function writePeerDependencies({ name }) {
  const packageJson = JSON.parse((await fs.readFile('./package.json')).toString());
  let meteorPackageNamesMaybeWithVersions;
  if (await fs.pathExists('.meteor/packages')) {
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
  else {
    meteorPackageNamesMaybeWithVersions = Object.entries(packageJson.dependencies)
      .map(([nodeName, version]) => ({
        nodeName,
        version,
      }))
      .filter(({ nodeName }) => nodeName !== name)
      // TODO: maybe figure out how to get this to play nice with github, I don't think we really care too much
      .filter(({ version }) => !version.startsWith('git'));
  }

  const { finalVersions, badVersions } = await calculateVersions(meteorPackageNamesMaybeWithVersions);
  Object.keys(finalVersions).forEach((nodeName) => {
    if (packageJson.dependencies[nodeName]) {
      delete finalVersions[nodeName];
    }
  });
  if (badVersions.length) {
    console.log(badVersions);
    throw new Error('bad versions');
  }
  Object.entries(finalVersions).forEach(([depName, version]) => {
    if (!packageJson.dependencies[depName]) {
      if (version.startsWith('file:')) {
        packageJson.dependencies[depName] = version;
        delete finalVersions[depName];
      }
    }
    else {
      delete finalVersions[depName];
    }
  });

  packageJson.dependencies = Object.fromEntries(Object.entries(packageJson.dependencies).sort(([aName], [bName]) => aName.localeCompare(bName)));
  await fs.ensureDir(name);
  await fs.writeFile(`./${name}/package.json`, JSON.stringify(ret, null, 2));
  packageJson.dependencies[name] = `file:${name}`; // TODO: sort dependencies
  return fs.writeFile('./package.json', JSON.stringify(packageJson, null, 2));
}
