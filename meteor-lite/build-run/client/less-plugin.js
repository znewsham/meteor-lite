import fs from 'fs/promises';
import less from 'less';

let inProg = Promise.resolve();
export default function lessPlugin(cache) {
  return {
    name: 'less',
    async setup(build) {
      build.onLoad(
        { filter: /.(less|lessimport)$/ },
        async ({ path: filePath }) => {
          if (cache) {
            const cached = await cache.get(filePath);
            if (cached) {
              return {
                contents: cached.contents,
                loader: 'css',
              };
            }
          }
          if (filePath.endsWith('.import.less')) {
            const res = {
              contents: '',
              loader: 'css',
            };
            cache.set(filePath, '');
            return res;
          }
          const result = await less.render((await fs.readFile(filePath)).toString('utf8'), {
            filename: filePath,
            plugins: [/* importPlugin */],
            javascriptEnabled: true,
            sourceMap: { outputSourceFiles: true },
          });

          const res = {
            contents: result.css,
            loader: 'css',
          };
          if (cache) {
            await cache.set(filePath, result.css);
            // NOTE: this assumes that any imports have already been parsed as without
            result.imports.map(async (imp) => cache.addInvalidator(imp, filePath));
          }
          return res;
        },
      );
    },
  };
}
