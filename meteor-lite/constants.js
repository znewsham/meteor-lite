// a mapping of each arch to it's "parent" - if you add an export for `client` - it will be available to all the archs
export const ParentArchs = new Map([
  ['web.cordova', 'web.browser.legacy'],
  ['web.browser.legacy', 'web.browser'],
  ['web.browser', 'web'],
  ['web', 'client'],
]);
