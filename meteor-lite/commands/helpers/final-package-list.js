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
  deps.strong.forEach((depNodeName) => {
    populateReturnList(depNodeName, ret, loaded, written, [...chain, nodeName]);
  });
  deps.preload.forEach((depNodeName) => {
    if (loaded.has(depNodeName)) {
      populateReturnList(depNodeName, ret, loaded, written, [...chain, nodeName]);
    }
  });
  ret.push({
    nodeName,
    isLazy: deps.isLazy,
    onlyLoadIfProd: deps.isProdOnlyImplied,
    json: deps.json,
  });
  deps.unordered.forEach((depNodeName) => {
    populateReturnList(depNodeName, ret, loaded, written, [...chain, nodeName]);
  });
}

function populateDependencies2({
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
    strong: Object.keys(json.meteorTmp.dependencies || {}),
    preload: json.meteorTmp.preload?.[archName] || [],
    unordered: json.meteorTmp.unordered?.[archName] || [],
    isLazy: json.meteorTmp.lazy,
    json,

    // we only care about storing 'implied' prod-only, this is because the prod only entry point of a package already handles this
    // butwe may need to hoist the packages dependencies (and still create globals)
    isProdOnlyImplied,
  });
  const ret = [
    ...Object.entries(json.meteorTmp.dependencies).map(([depNodeName, version]) => ({
      nodeName: depNodeName,
      version,
      newState: { ...state, chainIsProdOnly: chainIsProdOnly || isProdOnly },
    })),
    ...Object.values(json.meteorTmp.unordered?.[archName] || {}).map((depNodeName) => ({
      nodeName: depNodeName,
      version: json.peerDependencies[depNodeName],
      newState: { ...state, chainIsProdOnly: chainIsProdOnly || isProdOnly },
    })),
  ];
  return ret;
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
    }) => populateDependencies2({
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
