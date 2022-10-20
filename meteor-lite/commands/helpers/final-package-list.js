import fs from 'fs/promises';
import { meteorNameToNodeName } from '../../helpers/helpers';

// leaving this in for posterity - it didn't work, but would have been cleaner.
// the advantage of the chosen solution is it should be possible to garuantee the exact same load order

// kinda gnarly, for a given packageJson, look at the preload dependencies and for each one add a reference
// between every package in the current load chain (including this one) and that preload dependency
// then record that we've seen this package (in case it's a preload dependency of something else)
// then recurse into all of the meteor dependencies of this package.

// additionally, we're gonna recurse into the postload dependencies to ensure that every unordered dependency is eventually required.
/*async function loadPackageIntoMapAndSet(
  loadedByNodeNames,
  packageJson,
  preloadDependencies,
  postloadDependencies,
  loaded,
  archName,
) {
  if (!packageJson.meteor && !packageJson.meteorTmp) {
    return;
  }
  const newLoadedByNodeNames = [...loadedByNodeNames, packageJson.name];
  if (loaded.has(packageJson.name)) {
    // we've already loaded this package, but a new package (chain) has depended on it
    // so just add all this packages preload dependencies to the chain.
    const { preLoaded } = loaded.get(packageJson.name);
    if (packageJson.name === '@meteor/webapp') {
      console.log(newLoadedByNodeNames, preLoaded);
    }
    if (preLoaded.length) {
      newLoadedByNodeNames.forEach((loadedByNodeName) => {
        if (!preloadDependencies.has(loadedByNodeName)) {
          preloadDependencies.set(loadedByNodeName, new Set(preLoaded));
        }
        else {
          const preloadSet = preloadDependencies.get(loadedByNodeName);
          preLoaded.forEach((preloadNodeName) => preloadSet.add(preloadNodeName));
        }
      });
    }
    return;
  }
  const preLoadDependenciesForPackage = [
    ...(packageJson.meteor?.preload?.[archName] || []),
  ];
  const postLoadDependenciesForPackage = [
    ...(packageJson.meteor?.unordered?.[archName] || []),
  ];
  loaded.set(packageJson.name, { preLoaded: preLoadDependenciesForPackage, postLoaded: postLoadDependenciesForPackage });
  if (preLoadDependenciesForPackage.length) {
    newLoadedByNodeNames.forEach((loadedByNodeName) => {
      if (!preloadDependencies.has(loadedByNodeName)) {
        preloadDependencies.set(loadedByNodeName, new Set(preLoadDependenciesForPackage));
      }
      else {
        const preloadSet = preloadDependencies.get(loadedByNodeName);
        preLoadDependenciesForPackage.forEach((preloadNodeName) => preloadSet.add(preloadNodeName));
      }
    });
  }
  if (packageJson.dependencies) {
    await Promise.all(Object.keys(packageJson.dependencies).map(async (depNodeName) => {
      const depPackageJSON = JSON.parse((await fs.readFile(`node_modules/${depNodeName}/package.json`)).toString());
      await loadPackageIntoMapAndSet(newLoadedByNodeNames, depPackageJSON, preloadDependencies, postloadDependencies, loaded, archName);
    }));
  }
  if (postLoadDependenciesForPackage.length) {
    newLoadedByNodeNames.forEach((loadedByNodeName) => {
      if (!postloadDependencies.has(loadedByNodeName)) {
        postloadDependencies.set(loadedByNodeName, new Set(postLoadDependenciesForPackage));
      }
      else {
        const postloadSet = postloadDependencies.get(loadedByNodeName);
        postLoadDependenciesForPackage.forEach((preloadNodeName) => postloadSet.add(preloadNodeName));
      }
    });
    await Promise.all(postLoadDependenciesForPackage.map(async (depNodeName) => {
      const depPackageJSON = JSON.parse((await fs.readFile(`node_modules/${depNodeName}/package.json`)).toString());
      await loadPackageIntoMapAndSet(newLoadedByNodeNames, depPackageJSON, preloadDependencies, postloadDependencies, loaded, archName);
    }));
  }
}*/

async function populateDependencies(nodeName, dependenciesMap, archName) {
  if (dependenciesMap.has(nodeName)) {
    return;
  }
  const depPackageJSON = JSON.parse((await fs.readFile(`node_modules/${nodeName}/package.json`)).toString());
  dependenciesMap.set(nodeName, {
    strong: Object.keys(depPackageJSON.dependencies),
    preload: depPackageJSON.meteor.preload?.[archName] || [],
    unordered: depPackageJSON.meteor.unordered?.[archName] || [],
    isLazy: depPackageJSON.meteor.lazy,
  });

  const allDeps = Array.from(new Set([
    ...Object.keys(depPackageJSON.meteorTmp.dependencies),
    ...depPackageJSON.meteor.unordered?.[archName] || [],
  ]));

  await Promise.all(allDeps.map(async (depNodeName) => {
    await populateDependencies(depNodeName, dependenciesMap, archName);
  }));
}

function populateReturnList(nodeName, ret, loaded, written, chain = []) {
  if (written.has(nodeName)) {
    return;
  }
  written.add(nodeName);
  const deps = loaded.get(nodeName);
  if (!deps) {
    return; // this better be because it's a node module...
  }
  deps.strong.forEach((depNodeName) => {
    populateReturnList(depNodeName, ret, loaded, written, [...chain, nodeName]);
  });
  deps.preload.forEach((depNodeName) => {
    if (loaded.has(depNodeName)) {
      populateReturnList(depNodeName, ret, loaded, written, [...chain, nodeName]);
    }
  });
  ret.push({ nodeName, isLazy: deps.isLazy });
  deps.unordered.forEach((depNodeName) => {
    populateReturnList(depNodeName, ret, loaded, written, [...chain, nodeName]);
  });
}

export async function getFinalPackageListForArch(packages, archName) {
  const loaded = new Map();
  const written = new Set();
  await Promise.all(packages.map(async (meteorName) => {
    const nodeName = meteorNameToNodeName(meteorName);
    await populateDependencies(nodeName, loaded, archName);
  }));
  const ret = [];
  packages.forEach((meteorName) => {
    const nodeName = meteorNameToNodeName(meteorName);
    populateReturnList(nodeName, ret, loaded, written);
  });

  return ret;
}
