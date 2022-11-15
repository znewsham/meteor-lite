import fs from 'fs-extra';
import path from 'path';
import pacote from 'pacote';
import { meteorNameToNodePackageDir, nodeNameToMeteorName } from '../../helpers/helpers';
import { getNpmRc, registryForPackage } from '../../helpers/ensure-npm-rc';

export default async function recurseMeteorNodePackages(
  startingList,
  recursionFunction,
  initialState = {},
  // TODO: pass this in
  localDirs = ['./npm-packages-local', './npm-packages-shared', './npm-packages'],
) {
  const packageJsonMap = new Map();
  let nextPackages = startingList.slice(0);
  const npmRc = await getNpmRc();
  while (nextPackages.length) {
    // eslint-disable-next-line
    nextPackages = (await Promise.all(nextPackages.map(async ({
      nodeName,
      version,
      newState,
      loadedChain = [],
      evaluateTestPackage = false,
    }) => {
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
        if (localDirs?.length) {
          const localFolderName = meteorNameToNodePackageDir(nodeNameToMeteorName(nodeName));
          const results = (await Promise.all(localDirs.map(async (localDir) => {
            const pathToLocalInner = path.join(localDir, localFolderName, 'package.json');
            if (await fs.pathExists(pathToLocalInner)) {
              return {
                pathToLocal: pathToLocalInner,
                json: JSON.parse((await fs.readFile(pathToLocalInner)).toString()),
              };
            }
            return undefined;
          }))).filter(Boolean);
          if (results.length) {
            json = results[0].json;
            pathToLocal = results[0].pathToLocal;
          }
        }
        if (!json) {
          try {
            const actualPackageSpec = await pacote.resolve(packageSpec, options);
            json = await pacote.manifest(actualPackageSpec, options);
          }
          catch (e) {
            json = packageJsonMap.get(packageSpec);
            if (!json) {
              // so we don't warn on a race condition
              // NOTE: this is really noisy and not super useful
              // warn(`Couldn't load ${newState?.isWeak ? 'weak ' : ''}package: ${packageSpec} because ${e.message} loaded by ${loadedChain}`);
              if (!newState?.isWeak) {
                throw e;
              }
              json = {};
            }
          }
        }
        packageJsonMap.set(packageSpec, json);
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
        evaluateTestPackage,
      })) || [];
      if (!has) {
        return ret.map((item) => ({ loadedChain: [...loadedChain, packageSpec], ...item }));
      }
      return [];
    }))).flat();
  }
}
