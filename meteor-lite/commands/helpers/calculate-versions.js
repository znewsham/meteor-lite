import semver from 'semver';
import path, { relative } from 'path';
import recurseMeteorNodePackages from './recurse-meteor-node-packages.js';

// TODO: do this properly
function relativePathForBase(absoluteBasePath, relativePath) {
  return relativePath;
}

export default async function calculateVersions(nodePackagesAndVersions) {
  const strongVersionsMap = new Map();
  const weakVersionsMap = new Map();
  const localPackages = new Map();
  await recurseMeteorNodePackages(nodePackagesAndVersions, async ({
    nodeName,
    requestedVersion,
    json,
    loadedChain,
    state,
    pathToLocal,
  }) => {
    let versionsMap = strongVersionsMap;
    if (pathToLocal) {
      localPackages.set(nodeName, relativePathForBase(path.resolve('./'), pathToLocal));
    }
    if (state.isWeak) {
      versionsMap = weakVersionsMap;
    }
    if (!versionsMap.has(nodeName)) {
      versionsMap.set(nodeName, new Set());
    }
    if (requestedVersion) {
      versionsMap.get(nodeName).add(requestedVersion);
    }
    if (!json && state.isWeak) {
      return [];
    }
    if (!json) {
      throw new Error(`Couldn't resolve ${nodeName}@${requestedVersion}`);
    }
    versionsMap.get(nodeName).add(json.version);
    return [
      ...Object.entries(json.meteorTmp.dependencies).map(([depNodeName, version]) => ({ nodeName: depNodeName, version, newState: state })),
      ...Object.entries(json.meteorTmp.weakDependencies || {}).map(([depNodeName, version]) => ({ nodeName: depNodeName, version, newState: { ...state, isWeak: true } })),
    ];
  });

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
    const matching = versions.filter((version) => versions.every((versionToSatisfy) => semver.satisfies(version, `^${versionToSatisfy}`)));
    if (!matching.length) {
      badVersions.push({ nodeName, versions });
    }
    matching.sort((versionA, versionB) => -semver.compare(versionA, versionB));
    if (!localPackages.has(nodeName)) {
      versionToUse = matching[0];
    }
    finalVersions[nodeName] = versionToUse;
  });
  return {
    finalVersions,
    badVersions,
  };
}
