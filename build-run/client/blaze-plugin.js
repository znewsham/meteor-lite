import fs from 'fs/promises';
import path from 'path';

let htmlHeader;
const htmlHeaderPath = path.join(path.dirname(import.meta.url.replace('file:', '')), 'blaze-html-header.js');
async function getHtmlHeader() {
  if (!htmlHeader) {
    htmlHeader = (await fs.readFile(htmlHeaderPath)).toString().split('\n').filter((line) => !line.startsWith('//')).join('\n');
  }
  return htmlHeader;
}

async function getTemplatingTools() {
  await import('@meteor/modern-browsers');
  const { TemplatingTools } = await import('@meteor/templating-tools');
  return TemplatingTools;
}

export default function blazePlugin(cache) {
  return {
    name: 'blaze',
    async setup(build) {
      // HACK: required because templating-tools imports ecma-runtime-client (somewhere)
      // and that's a CJS module that imports the ESM module modern-browsers
      // and the CJS entry point for an ESM module just re-exports Package[name]
      // we need to import the CJS module first.
      // this isn't "required" in an app because the generation of dependencies.js handles this
      const TemplatingTools = await getTemplatingTools();
      build.onLoad(
        { filter: /\.html$/ },
        async ({ path: filePath }) => {
          if (cache) {
            const cached = await cache.get(filePath);
            if (cached) {
              return {
                contents: cached.contents,
                loader: 'js',
              };
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
          const importStr = [
            filePath.includes('templating-runtime')
              ? 'import globals from "./__globals.js"; const { Template } = globals'
              : 'import { Template } from "@meteor/templating-runtime"',
            await getHtmlHeader(),
          ].join('\n');
          const res = {
            contents: `${importStr}${result.js}`,
            loader: 'js',
          };
          if (cache) {
            await cache.set(filePath, res.contents);
          }
          return res;
        },
      );
    },
  };
}
