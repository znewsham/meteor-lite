import path from 'path';
import fsExtra from 'fs-extra';

export default function addJsExtension(buildRoot) {
  return {
    name: 'meteor-node-stubs',
    setup(build) {
      build.onResolve({ filter: /.*/ }, async ({ path: filePath }) => {
        // we're just dealing with meteor packages
        if (!filePath.startsWith('@meteor/')) {
          return undefined;
        }

        // we're just dealing with things without extensions
        if (filePath.match(/\.[a-zA-Z0-9]{2,4}$/)) {
          return undefined;
        }

        // we only care about submodule import e.g. @meteor/minimongo/constants
        if (filePath.split('/').length === 2) {
          return undefined;
        }

        // we're just dealing with things that don't map to a package.json
        const importPath = path.resolve(path.join(buildRoot, 'node_modules', filePath));
        if (!await fsExtra.pathExists(importPath)) {
          return {
            path: `${importPath}.js`,
          };
        }
        return undefined;
      });
    },
  };
}
