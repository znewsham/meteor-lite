import { meteorVersionToSemver } from '../../helpers/helpers';
import recurseMeteorNodePackages from './recurse-meteor-node-packages';

// this was an attempt to get the load order correct, but it failed misserably.
// the load order of weak + strong dependencies is very strange, e.g.,:
/*
  ecmascript-runtime
  ...
  modern-browsers
  es5-shim
  promise
  ecmascript-runtime-client
*/
function populateReturnList2(nodeNames, ret, loaded, written) {
  if (!nodeNames.length) {
    return;
  }
  const allPreDeps = new Set();
  const allPostDeps = new Set();
  const weakDeps = new Set();
  const toPush = [];
  nodeNames.forEach((nodeName) => {
    if (written.has(nodeName)) {
      return;
    }
    written.add(nodeName);
    const deps = loaded.get(nodeName);
    if (deps.uses) {
      deps.uses.forEach(({ name: depNodeName, weak, unordered }) => {
        if (weak) {
          weakDeps.add(depNodeName);
        }
        if (unordered) {
          allPostDeps.add(depNodeName);
        }
        else {
          allPreDeps.add(depNodeName);
        }
      });
    }
    else {
      deps.strong.forEach((depNodeName) => {
        allPreDeps.add(depNodeName);
      });
      deps.preload.forEach((depNodeName) => {
        allPreDeps.add(depNodeName);
        weakDeps.add(depNodeName);
      });
      deps.unordered.forEach((depNodeName) => {
        allPostDeps.add(depNodeName);
      });
    }
    toPush.push({
      nodeName,
      isLazy: deps.isLazy,
      onlyLoadIfProd: deps.isProdOnlyImplied,
      json: deps.json,
    });
  });
  const depsToPreLoad = Array.from(allPreDeps).filter((depNodeName) => !written.has(depNodeName) && (!weakDeps.has(depNodeName) || loaded.has(depNodeName)));
  const depsToPostLoad = Array.from(allPostDeps).filter((depNodeName) => !written.has(depNodeName));
  populateReturnList2(depsToPreLoad, ret, loaded, written);
  ret.push(...toPush);
  populateReturnList2(depsToPostLoad, ret, loaded, written);
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
  // TODO: the order here is still wrong - but the code is marginally cleaner.
  // if we care about the *exact* order, we need to fetch "all the dependencies of preload and strong in order"
  // then output all the dependencies first, then strong/preload in order.
  // this is still recursive, but the recursion happens at the "package" layer rather than "per dependency"
  // we want to see:
  /*
    ecmascript-runtime
    ...
    modern-browsers
    es5-shim
    promise
    ecmascript-runtime-client
  */
  let strongAndPreload;
  let preloads;
  let unorderedDeps;
  if (deps.uses) {
    strongAndPreload = new Set();
    unorderedDeps = new Set();
    preloads = new Set();
    deps.uses.forEach(({ name: depNodeName, weak, unordered }) => {
      if (weak) {
        preloads.add(depNodeName);
      }
      if (unordered) {
        unorderedDeps.add(depNodeName);
      }
      else {
        strongAndPreload.add(depNodeName);
      }
    });
  }
  else {
    strongAndPreload = new Set([
      ...deps.strong,
      ...deps.preload,
    ]);
    preloads = new Set(deps.preload);
    unorderedDeps = new Set(deps.unordered);
  }

  strongAndPreload.forEach((depNodeName) => {
    const preload = preloads.has(depNodeName);
    if (!preload || loaded.has(depNodeName)) {
      populateReturnList(depNodeName, ret, loaded, written, [...chain, nodeName]);
    }
  });
  ret.push({
    nodeName,
    isLazy: deps.isLazy,
    onlyLoadIfProd: deps.isProdOnlyImplied,
    json: deps.json,
  });
  unorderedDeps.forEach((depNodeName) => {
    populateReturnList(depNodeName, ret, loaded, written, [...chain, nodeName]);
  });
}

function populateDependencies({
  nodeName,
  json,
  state,
  dependenciesMap,
  archName,
}) {
  const { chainIsProdOnly } = state;
  if (dependenciesMap.has(nodeName)) {
    const existing = dependenciesMap.get(nodeName);
    if (existing.isProdOnlyImplied && !chainIsProdOnly) {
      // something not prod-only is requiring this.
      existing.isProdOnlyImplied = false;
    }
    // TODO: version control here?
    // if we've pulled in a newer version we should replace?
    // Or is this already handled by the version constraints earlier?
    return [];
  }
  dependenciesMap.set(nodeName, {});
  const isProdOnly = !!json.exports?.['.']?.production;
  const isProdOnlyImplied = chainIsProdOnly;
  dependenciesMap.set(nodeName, {
    uses: json.meteorTmp.uses,
    strong: Object.keys(json.meteorTmp.dependencies || {}),
    preload: json.meteorTmp.preload?.[archName] || [],
    unordered: json.meteorTmp.unordered?.[archName] || [],
    isLazy: json.meteorTmp.lazy,
    json,

    // we only care about storing 'implied' prod-only, this is because the prod only entry point of a package already handles this
    // butwe may need to hoist the packages dependencies (and still create globals)
    isProdOnlyImplied,
  });
  return [
    ...json.meteorTmp.uses.map(({ name: depNodeName, constraint, weak, archs }) => {
      if (weak) {
        return undefined;
      }
      if (archs && !archs.includes(archName)) {
        return undefined;
      }
      return {
        nodeName: depNodeName,
        version: constraint && meteorVersionToSemver(constraint),
        newState: { ...state, chainIsProdOnly: chainIsProdOnly || isProdOnly },
      };
    }).filter(Boolean),
    ...(json.meteorTmp.implies?.filter(({ archs }) => !archs || archs.includes(archName)) || []).map(({ name: depNodeName, constraint, weak, archs }) => {
      if (weak) {
        return undefined;
      }
      if (archs && !archs.includes(archName)) {
        return undefined;
      }
      return {
        nodeName: depNodeName,
        version: constraint && meteorVersionToSemver(constraint),
        newState: { ...state, chainIsProdOnly: chainIsProdOnly || isProdOnly },
      };
    }).filter(Boolean),
  ];
}

export async function getFinalPackageListForArch(nodePackagesAndVersions, archName) {
  const loaded = new Map();
  const written = new Set();
  await recurseMeteorNodePackages(
    nodePackagesAndVersions,
    ({
      nodeName,
      requestedVersion,
      json,
      loadedChain,
      state,
      pathToLocal,
    }) => populateDependencies({
      nodeName,
      requestedVersion,
      json,
      loadedChain,
      state,
      pathToLocal,
      // NOTE: these could both be passed in as state, not sure it's a meaningful difference
      dependenciesMap: loaded,
      archName,
    }),
  );
  const ret = [];
  nodePackagesAndVersions.forEach(({ nodeName }) => {
    populateReturnList(nodeName, ret, loaded, written);
  });

  return ret;
}
