import { meteorVersionToSemver } from '../../helpers/helpers';
import recurseMeteorNodePackages from './recurse-meteor-node-packages';

function populateReturnList(nodeName, ret, loaded, written, chain = []) {
  if (written.has(nodeName)) {
    return;
  }
  written.add(nodeName);
  const deps = loaded.get(nodeName);
  if (!deps) {
    return; // this better be because it's a node module...
  }
  // NOTE: the order here is still wrong - but the code is marginally cleaner.
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
    onlyLoadIfDev: deps.isDevOnlyImplied,
    isIndirectDependency: deps.isIndirectDependency,
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
  const { chainIsProdOnly, chainIsDevOnly, chainIsIndirectDependency } = state;
  if (dependenciesMap.has(nodeName)) {
    const existing = dependenciesMap.get(nodeName);
    if (existing.isIndirectDependency && !chainIsIndirectDependency) {
      existing.isIndirectDependency = false;
    }
    if (existing.isProdOnlyImplied && !chainIsProdOnly) {
      // something not prod-only is requiring this.
      existing.isProdOnlyImplied = false;
    }
    if (existing.isDevOnlyImplied && !chainIsDevOnly) {
      // something not prod-only is requiring this.
      existing.isDevOnlyImplied = false;
    }
    // NOTE: version control here?
    // if we've pulled in a newer version we should replace?
    // Or is this already handled by the version constraints earlier?
    return [];
  }
  dependenciesMap.set(nodeName, {});
  const isProdOnly = !!json.exports?.['.']?.production;
  const isDevOnly = !!json.exports?.['.']?.development;
  const isProdOnlyImplied = chainIsProdOnly;
  const isDevOnlyImplied = chainIsDevOnly;
  const isIndirectDependency = chainIsIndirectDependency;
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
    isDevOnlyImplied,
    isIndirectDependency,
  });
  return [
    ...json.meteorTmp.uses.map(({
      name: depNodeName,
      constraint,
      weak,
      archs,
    }) => {
      if (weak) {
        return undefined;
      }
      if (archs && !archs.includes(archName)) {
        return undefined;
      }
      return {
        nodeName: depNodeName,
        version: constraint && meteorVersionToSemver(constraint),
        newState: {
          ...state,
          chainIsProdOnly: chainIsProdOnly || isProdOnly,
          chainIsDevOnly: chainIsDevOnly || isDevOnly,

          // as soon as we dip into an api.uses call - that package's exports shouldn't be set as globals
          chainIsIndirectDependency: true,
        },
      };
    }).filter(Boolean),
    ...(json.meteorTmp.implies?.filter(({ archs }) => !archs || archs.includes(archName)) || [])
      .map(({
        name: depNodeName,
        constraint,
        weak,
        archs,
      }) => {
        if (weak) {
          return undefined;
        }
        if (archs && !archs.includes(archName)) {
          return undefined;
        }
        return {
          nodeName: depNodeName,
          version: constraint && meteorVersionToSemver(constraint),
          newState: {
            ...state,
            chainIsProdOnly: chainIsProdOnly || isProdOnly,
            chainIsDevOnly: chainIsDevOnly || isDevOnly,
            chainIsIndirectDependency,
          },
        };
      })
      .filter(Boolean),
  ];
}

export async function getFinalPackageListForArch(nodePackagesAndVersions, archName, localDirs) {
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
    {
      localDirs
    },
  );
  const ret = [];
  nodePackagesAndVersions.forEach(({ nodeName }) => {
    populateReturnList(nodeName, ret, loaded, written);
  });

  return ret;
}
