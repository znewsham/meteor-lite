import path from 'path';

// TODO: everything else in meteor-node-stubs - and what happens if it's installed at the top level and not in meteor-node-stubs
const replaces = {
  util: 'node_modules/meteor-node-stubs/node_modules/util/util.js',
};

export default function stubsPlugin(buildRoot) {
  return {
    name: 'meteor-node-stubs',
    setup(build) {
      build.onResolve({ filter: /.*/ }, async ({ path: filePath }) => {
        if (replaces[filePath]) {
          const newPath = path.resolve(path.join(buildRoot, replaces[filePath]));
          return {
            path: newPath,
          };
        }
        return undefined;
      });
    },
  };
}
