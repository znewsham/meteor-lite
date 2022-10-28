import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import pacote from 'pacote';
import { meteorNameToNodePackageDir, nodeNameToMeteorName } from '../../helpers/helpers';

async function getNpmRc() {
  const npmRcKeyValuePairs = new Map();
  const lines = [];
  if (await fs.pathExists(path.join(os.homedir(), '.npmrc'))) {
    lines.push(...(await fs.readFile(path.join(os.homedir(), '.npmrc'))).toString().split('\n'));
  }
  if (await fs.pathExists('.npmrc')) {
    lines.push(...(await fs.readFile('.npmrc')).toString().split('\n'));
  }
  lines.forEach((kv) => {
    const [key, value] = kv.trim().split(/\s*=\s*/);
    if (!key || key.startsWith('#')) {
      return;
    }
    npmRcKeyValuePairs.set(key, value);
  });
  return npmRcKeyValuePairs;
}

// TODO: pass in as option
export default async function recurseMeteorNodePackages(startingList, recursionFunction, initialState = {}, localDir = './npm-packages') {
  const packageJsonMap = new Map();
  let nextPackages = startingList.slice(0);
  const npmRc = await getNpmRc();
  while (nextPackages.length) {
    // eslint-disable-next-line
    nextPackages = (await Promise.all(nextPackages.map(async ({ nodeName, version, newState, loadedChain = [] }) => {
      const options = {
        fullReadJson: true,
        fullMetadata: true,
        where: process.cwd(),
      };
      if (nodeName.startsWith('@')) {
        const scope = nodeName.split('/')[0];
        const registry = npmRc.get(`${scope}:registry`);
        if (registry) {
          options.registry = registry;
        }
      }
      const packageSpec = version ? `${nodeName}@${version}` : nodeName;
      const has = packageJsonMap.has(packageSpec);
      let json = packageJsonMap.get(packageSpec);
      let pathToLocal;

      // use has since we set to undefined below
      if (!has) {
        // TODO: pull from local directories
        if (localDir) {
          const localFolderName = meteorNameToNodePackageDir(nodeNameToMeteorName(nodeName));
          pathToLocal = path.join(localDir, localFolderName, 'package.json');
          if (await fs.pathExists(pathToLocal)) {
            json = JSON.parse((await fs.readFile(pathToLocal)).toString());
          }
          else {
            pathToLocal = undefined;
          }
        }
        if (!json) {
          try {
            json = await pacote.manifest(packageSpec, options);
          }
          catch (e) {
            console.warn(`Couldn't load ${newState?.isWEak ? 'weak ' : ''}package: ${packageSpec} because ${e.message}`);
          }
        }
        packageJsonMap.set(`${nodeName}@${version}`, json);
      }

      // we really only care about meteor packages
      if (json && !json.meteor) {
        return [];
      }
      const ret = (await recursionFunction({
        nodeName,
        requestedVersion: version,
        json,
        loadedChain,
        state: { ...initialState, ...newState },
        pathToLocal: pathToLocal && path.dirname(pathToLocal),
      })) || [];
      if (!has) {
        return ret.map((item) => ({ loadedChain: [...loadedChain, packageSpec], ...item }));
      }
      return [];
    }))).flat();
  }
}
