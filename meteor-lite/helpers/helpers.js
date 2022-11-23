import semver from 'semver';

export function meteorNameToNodeName(name) {
  if (name.includes(':')) {
    return `@${name.split(':').join('/')}`;
  }
  return `@meteor/${name}`;
}

export function nodeNameToMeteorName(name) {
  if (name.startsWith('@meteor/')) {
    return name.split('/')[1];
  }
  return name.slice(1).split('/').join(':');
}

export function meteorNameToNodePackageDir(packageName) {
  // @meteor/whatever -> whatever
  if (!packageName.includes(':')) {
    return packageName;
  }
  return `@${packageName.split(':').join('/')}`;
}

export function meteorNameToLegacyPackageDir(packageName) {
  // @meteor/whatever -> whatever
  if (!packageName.includes(':')) {
    return packageName;
  }
  return packageName.split(':').join('_');
}

// meteor treats 0.x versions the same as 1.x, semver does not.
export function versionsAreCompatible(loadedVersion, requestedVersion) {
  const requestedVersions = requestedVersion.split(/\s*\|\|\s*/);
  const loadedSemver = semver.coerce(loadedVersion);
  return requestedVersions.find((actualRequestedVersion) => {
    const requestedSemver = semver.coerce(actualRequestedVersion);
    return loadedSemver.major === requestedSemver.major;
  });
}

export function sortSemver(arr) {
  return arr.sort((a, b) => {
    const semverA = semver.coerce(a);
    const semverB = semver.coerce(b);
    return semver.compare(semverA, semverB);
  });
}

export function meteorVersionToSemver(versions) {
  return versions.split(/\s*\|\|\s*/).map((versionConstraint) => {
    if (versionConstraint.startsWith('^')) {
      return versionConstraint;
    }
    return (versionConstraint.startsWith('0') ? '0.x' : `^${versionConstraint}`);
  }).join(' || ');
}
