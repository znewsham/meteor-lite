import fs from 'fs/promises';
import less from 'less';
import { getCacheEntry, setCacheEntry } from './helpers';

export default function lessPlugin(cacheDirectory, cacheMap) {
  return {
    name: 'less',
    async setup(build) {
      build.onLoad(
        { filter: /.(less|lessimport)$/ },
        async ({ path: filePath }) => {
          const stat = await fs.stat(filePath);
          const cacheKey = stat.mtime.toString();
          const cached = cacheMap.get(filePath);
          if (cached && cached.cacheKey === cacheKey) {
            return cached.result;
          }
          if (cached) {
            cached.invalidates.forEach((invalidated) => cacheMap.delete(invalidated));
          }
          if (filePath.endsWith('.import.less')) {
            const res = {
              contents: '',
              loader: 'css',
            };
            cacheMap.set(filePath, { result: res, cacheKey, invalidates: new Set() });
            return res;
          }
          if (cacheDirectory) {
            const cacheContents = await getCacheEntry(cacheDirectory, filePath, stat.mtimeMs);
            if (cacheContents) {
              const res = {
                contents: cacheContents,
                loader: 'css',
              };
              cacheMap.set({
                result: res,
                cacheKey,
                invalidates: new Set(),
              });
              return res;
            }
          }
          const result = await less.render((await fs.readFile(filePath)).toString('utf8'), {
            filename: filePath,
            plugins: [/* importPlugin */],
            javascriptEnabled: true,
            sourceMap: { outputSourceFiles: true },
          });

          if (cacheDirectory) {
            setCacheEntry(cacheDirectory, filePath, result.css);
          }

          const res = {
            contents: result.css,
            loader: 'css',
          };

          cacheMap.set(filePath, {
            result: res,
            cacheKey,
            invalidates: new Set(),
          });
          result.imports.forEach((imp) => {
            cacheMap.get(imp).invalidates.add(filePath);
          });

          return res;
        },
      );
    },
  };
}
