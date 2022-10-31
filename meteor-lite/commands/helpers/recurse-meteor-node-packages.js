import fs from 'fs-extra';
import path from 'path';
import pacote from 'pacote';
import { meteorNameToNodePackageDir, nodeNameToMeteorName } from '../../helpers/helpers';
import { getNpmRc, registryForPackage } from '../../helpers/ensure-npm-rc';

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
      const registry = await registryForPackage(nodeName, npmRc);
      if (registry) {
        options.registry = registry;
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
            console.warn(`Couldn't load ${newState?.isWeak ? 'weak ' : ''}package: ${packageSpec} because ${e.message}`);
            if (!newState?.isWeak) {
              console.log(loadedChain)
              throw e;
            }
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
