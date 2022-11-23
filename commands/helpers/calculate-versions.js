import recurseMeteorNodePackages from './recurse-meteor-node-packages.js';
import { meteorVersionToSemver, versionsAreCompatible } from '../../helpers/helpers.js';
import { warn } from '../../helpers/log.js';

function recursionFunction({
  nodeName,
  requestedVersion,
  json,
  state,
  pathToLocal,
  evaluateTestPackage,
  strongVersionsMap,
  weakVersionsMap,
  localPackages,
}) {
  let versionsMap = strongVersionsMap;
  if (pathToLocal) {
    localPackages.set(nodeName, pathToLocal);
  }
  if (state.isWeak) {
    versionsMap = weakVersionsMap;
  }
  if (!versionsMap.has(nodeName)) {
    versionsMap.set(nodeName, new Set());
  }
  if (requestedVersion && !requestedVersion.startsWith('file:')) {
    versionsMap.get(nodeName).add(requestedVersion);
  }
  if (!json && state.isWeak) {
    return [];
  }
  if (!json) {
    throw new Error(`Couldn't resolve ${nodeName}@${requestedVersion}`);
  }
  versionsMap.get(nodeName).add(json.version);
  const uses = evaluateTestPackage ? json.meteorTmp.testUses : json.meteorTmp.uses;
  if (!uses) {
    if (evaluateTestPackage) {
      warn('no uses for', nodeName, 'this usually happens when a package has .onTest but doesn\'t do anything');
      return [];
    }
    throw new Error('no uses for: ' + nodeName);
  }
  return [
    ...uses.map(({ name: depNodeName, constraint, weak, unordered }) => {
      if (unordered) {
        return undefined;
      }
      return {
        nodeName: depNodeName,
        version: constraint && meteorVersionToSemver(constraint),
        newState: { ...state, isWeak: !!weak },
      };
    }).filter(Boolean),
    ...json.meteorTmp.implies.map(({ name: depNodeName, constraint }) => ({
      nodeName: depNodeName,
      version: constraint && meteorVersionToSemver(constraint),
      newState: state,
    })),
  ];
}
export default async function calculateVersions(
  nodePackagesAndVersions,
  localDirs,
) {
  const strongVersionsMap = new Map();
  const weakVersionsMap = new Map();
  const localPackages = new Map();
  await recurseMeteorNodePackages(
    nodePackagesAndVersions,
    async ({
      nodeName,
      requestedVersion,
      json,
      loadedChain,
      state,
      pathToLocal,
      evaluateTestPackage,
    }) => recursionFunction({
      nodeName,
      requestedVersion,
      json,
      loadedChain,
      state,
      pathToLocal,
      evaluateTestPackage,
      strongVersionsMap,
      weakVersionsMap,
      localPackages,
    }),
    {
      localDirs,
    },
  );

  weakVersionsMap.forEach((versions, name) => {
    if (strongVersionsMap.has(name)) {
      versions.forEach((version) => strongVersionsMap.get(name).add(version));
    }
  });

  const versionsMap = strongVersionsMap;
  const badVersions = [];
  const finalVersions = {};
  Array.from(versionsMap.entries()).forEach(([nodeName, versionsSet]) => {
    const versions = Array.from(versionsSet);
    let [versionToUse] = versions;
    if (localPackages.has(nodeName)) {
      versionToUse = `file:${localPackages.get(nodeName)}`;
    }

    if (versionsSet.size === 1) {
      finalVersions[nodeName] = versionToUse;
      return;
    }
    const matching = versions.filter((version) => versions.every((versionToSatisfy) => versionsAreCompatible(version, versionToSatisfy)));
    if (!matching.length) {
      badVersions.push({ nodeName, versions });
    }
    if (!localPackages.has(nodeName)) {
      versionToUse = matching.slice(-1)[0];
    }
    finalVersions[nodeName] = versionToUse;
  });
  return {
    finalVersions,
    badVersions,
  };
}
