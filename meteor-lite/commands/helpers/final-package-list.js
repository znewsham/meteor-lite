import fs from 'fs/promises';
import { meteorNameToNodeName } from '../../helpers/helpers';

async function populateDependencies(nodeName, dependenciesMap, archName, chainIsProdOnly) {
  if (dependenciesMap.has(nodeName)) {
    const existing = dependenciesMap.get(nodeName);
    if (existing.isProdOnlyImplied && !chainIsProdOnly) {
      // something not prod-only is requiring this.
      existing.isProdOnlyImplied = false;
    }
    return;
  }
  dependenciesMap.set(nodeName, {});
  const depPackageJSON = JSON.parse((await fs.readFile(`node_modules/${nodeName}/package.json`)).toString());
  const isProdOnly = !!depPackageJSON.exports?.['.']?.production;
  const isProdOnlyImplied = chainIsProdOnly;
  dependenciesMap.set(nodeName, {
    strong: Object.keys(depPackageJSON.meteor.dependencies),
    preload: depPackageJSON.meteor.preload?.[archName] || [],
    unordered: depPackageJSON.meteor.unordered?.[archName] || [],
    isLazy: depPackageJSON.meteor.lazy,

    // we only care about storing 'implied' prod-only, this is because the prod only entry point of a package already handles this
    // butwe may need to hoist the packages dependencies (and still create globals)
    isProdOnlyImplied,
  });

  const allDeps = Array.from(new Set([
    ...Object.keys(depPackageJSON.meteorTmp.dependencies),
    ...depPackageJSON.meteor.unordered?.[archName] || [],
  ]));

  await Promise.all(allDeps.map(async (depNodeName) => {
    await populateDependencies(depNodeName, dependenciesMap, archName, chainIsProdOnly || isProdOnly);
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
  ret.push({ nodeName, isLazy: deps.isLazy, onlyLoadIfProd: deps.isProdOnlyImplied });
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
