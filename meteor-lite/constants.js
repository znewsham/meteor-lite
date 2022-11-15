// a mapping of each arch to it's "parent" - if you add an export for `client` - it will be available to all the archs
export const ParentArchs = new Map([
  ['web.cordova', 'web.browser.legacy'],
  ['web.browser.legacy', 'web.browser'],
  ['web.browser', 'web'],
  ['web', 'client'],
]);

// these packages will all be ignored, mostly they're build packages,
// the only ones that aren't have a strong dependency on modules package
export const ExcludePackageNames = new Set([
  // TODO: this causes trouble with shell-server
  // 'ecmascript', - we need this because of how stupid meteor packages are, that they get access to the globals of every package dependency
  'typescript',
  'coffeescript',
  'modules',
  'modules-runtime',
  'caching-compiler',
  'caching-html-compiler',
  'minifier-css',
  'less',
  'minifiers',
  'isobuild:compiler-plugin',
  'isobuild:dynamic-import',
  'ecmascript-runtime-server', // just provides babel polyfills - we're going to require that server code be compliant?
  'isobuild:minifier-plugin',
  'standard-minifier-css',
  'standard-minifier-js',
  'dynamic-import', // this has a strong dependency on modules
  'hot-module-replacement', // this has a strong dependency on modules
  'meteor-tool',
  'ddp-client-isopacket',
  'isobuild:linter-plugin',
  'isobuild:isopack-2',
  'reload-safetybelt', // not "really" required - but it doesn't play nice with client side modules (it expects the file to finish sync)
  'stylus',
  // these are just helpers so we can pass in the packages directory for conversion
  'deprecated',
  'non-core',

]);
