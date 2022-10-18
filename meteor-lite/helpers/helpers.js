export const ParentArchs = new Map([
  ['web.browser.legacy', 'web.browser'],
  ['web.browser', 'web'],
  ['web.cordova', 'web.browser.legacy'],
  ['web', 'client'],
]);

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
