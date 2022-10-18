import fsPromises from 'fs/promises';
import * as acorn from 'acorn';
import path from 'path';
import { walk } from 'estree-walker';
import { pathExists } from 'fs-extra';
import { acornOptions } from './globals.js';

export async function resolveFile(actualFile) {
  if (await pathExists(`${actualFile}.js`)) {
    return `${actualFile}.js`;
  }
  if (await pathExists(actualFile)) {
    const fileEntry = await fsPromises.stat(actualFile);
    if (fileEntry.isDirectory()) {
      return `${actualFile}/index.js`;
    }
    return actualFile;
  }
  return false;
}

export async function getImportTreeForFile(outputFolder, absoluteFile, arch, archsForFilesMap, ast) {
  const actualFile = absoluteFile;
  try {
    if (!actualFile || !actualFile.endsWith('.js')) {
      return [];
    }
    const baseFile = actualFile.replace(outputFolder, '.');
    if (archsForFilesMap.has(baseFile) && archsForFilesMap.get(baseFile).has(arch)) {
      return [];
    }
    if (!archsForFilesMap.has(baseFile)) {
      archsForFilesMap.set(baseFile, new Set([arch]));
    }
    else {
      archsForFilesMap.get(baseFile).add(arch);
    }
    const contents = (await fsPromises.readFile(actualFile)).toString();
    if (!ast) {
      ast = acorn.parse(
        contents,
        acornOptions,
      );
    }

    const toFind = new Set();
    ast.body.forEach((node) => {
      if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration' || node.type === 'ExportAllDeclaration') && node.source && node.source.value.match(/^\.\.?\//)) {
        toFind.add(node.source.value);
      }
      if (node.type === 'ImportDeclaration' && node.source.value.match(/^\.\.?\//)) {
        toFind.add(node.source.value);
      }
    });
    return Promise.all(Array.from(toFind).map(async (newFile) => {
      const result = await resolveFile(path.join(path.dirname(actualFile), newFile));
      if (!result) {
        console.log(outputFolder, newFile);
      }
      return result;
    }));
  }
  catch (e) {
    console.error(`problem with file ${absoluteFile} ${actualFile}`);
    throw e;
  }
}
