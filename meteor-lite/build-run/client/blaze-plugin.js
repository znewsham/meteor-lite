import fs from 'fs/promises';
import { getCacheEntry, setCacheEntry } from './helpers';

export default function blazePlugin(cacheDirectory, cacheMap) {
  return {
    name: 'blaze',
    async setup(build) {
      // HACK: required because templating-tools imports ecma-runtime-client (somewhere)
      // and that's a CJS module that imports the ESM module modern-browsers
      // and the CJS entry point for an ESM module just re-exports Package[name]
      // we need to import the CJS module first.
      // this isn't "required" in an app because the generation of dependencies.js handles this
      await import('@meteor/modern-browsers');
      const { TemplatingTools } = await import('@meteor/templating-tools');
      build.onLoad(
        { filter: /\.html$/ },
        async ({ path: filePath }) => {
          const stat = await fs.stat(filePath);
          const cacheKey = stat.mtime.toString();
          if (cacheMap.has(filePath)) {
            const cached = cacheMap.get(filePath);
            if (cached.cacheKey === cacheKey) {
              return cached.result;
            }
          }

          if (cacheDirectory) {
            const cacheContents = await getCacheEntry(cacheDirectory, filePath, stat.mtimeMs);
            if (cacheContents) {
              const res = {
                contents: cacheContents,
                loader: 'js',
              };
              cacheMap.set({
                result: res,
                cacheKey,
              });
              return res;
            }
          }
          const contents = (await fs.readFile(filePath)).toString();
          const tags = TemplatingTools.scanHtmlForTags({
            sourceName: filePath,
            contents,
            tagNames: ['body', 'head', 'template'],
          });
          const result = TemplatingTools.compileTagsWithSpacebars(tags);
          // most app html files don't need this (and can't use it anyway) but package globals aren't global anymore, so we need to import them
          // this happens as part of the conversion for JS, but HTML is compiled OTF.
          // TODO: move this to a static file
          const needsImport = true; // filePath.includes('/node_modules/') || filePath.includes('/npm-packages/') || filePath.includes('/packages/'); // hack for symlinks
          const importStr = [
            filePath.includes('templating-runtime')
              ? 'import globals from "./__globals.js"; const { Template } = globals'
              : 'import { Template } from "@meteor/templating-runtime"',
            'import { HTML } from "@meteor/htmljs";',
            'import { Blaze } from "@meteor/blaze";',
            'import { Spacebars } from "@meteor/spacebars";',
            'import { Meteor } from "@meteor/meteor";', // needed in case the HTML has <body> tags
          ].join('\n');
          const res = {
            contents: `${needsImport ? importStr : ''}${result.js}`,
            loader: 'js',
          };

          if (cacheDirectory) {
            setCacheEntry(cacheDirectory, filePath, res.contents);
          }

          cacheMap.set(filePath, { result: res, cacheKey });
          return res;
        },
      );
    },
  };
}
