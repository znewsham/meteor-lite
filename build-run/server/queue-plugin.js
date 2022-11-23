import fsExtra from 'fs-extra';
import fs from 'fs/promises';
import path from 'path';
import listFilesInDir from '../../helpers/list-files';

export default function queueForBuild(buildRoot, queue) {
  return {
    name: 'queue-for-build',
    async setup(build) {
      // even though we only care about ts/js files - if we don't include all files, imported node modules get rewritten weirdly
      build.onResolve({ filter: /.*/ }, async ({ kind, path: filePath, resolveDir }) => {
        const watchFiles = [];
        const watchDirs = [];
        if (kind === 'entry-point') {
          return {
            path: path.resolve(path.join(buildRoot, filePath)),
            watchFiles,
            watchDirs,
          };
        }
        // NOTE: this only works because the dependencies.js file imports every package. Otherwise we'd have to recurse into
        // every package (or at least every meteor package, arguably) to maybe watch every one of it's dependencies
        // we could possibly do this by just not treating them as external
        // this would be more correct - would follow the imports - and would trigger fewer server rebuilds incorrectly
        if (!filePath.startsWith('.') && !filePath.startsWith('/')) {
          let resolved = (await build.resolve(`node_modules/${filePath}`, { resolveDir })).path;

          // eslint-disable-next-line
          while (!await fsExtra.pathExists(resolved) && !resolved.endsWith('/node_modules/')) {
            resolved = resolved.split('/').slice(0, -1).join('/');
          }
          const stats = await fs.lstat(resolved);
          if (stats.isSymbolicLink()) {
            watchDirs.push(resolved);
            const files = await listFilesInDir(resolved);
            watchFiles.push(...files);
          }
        }
        else {
          queue.push(path.join(resolveDir.replace(`${buildRoot}/`, ''), filePath));
        }
        return {
          external: true,
          watchFiles,
          watchDirs,
        };
      });
    },
  };
}
