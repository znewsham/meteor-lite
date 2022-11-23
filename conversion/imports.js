import fsPromises from 'fs/promises';
import path from 'path';
import { pathExists } from 'fs-extra';
import { error as errorLog } from '../helpers/log';

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

const ImportExportTypes = new Set([
  'ExportNamedDeclaration',
  'ExportDefaultDeclaration',
  'ExportAllDeclaration',
  'ImportDeclaration',
]);

// we only care about relative paths - we're just trying to load the package tree
function nodeLoadsFile(node) {
  return ImportExportTypes.has(node.type) && node.source && node.source.value.match(/^\.\.?\//);
}

export async function getImportTreeForFile(baseFolder, absoluteFile, arch, archsForFilesMap, ast) {
  const actualFile = absoluteFile;
  try {
    if (!actualFile || !actualFile.endsWith('.js')) {
      return [];
    }
    const baseFile = actualFile.replace(baseFolder, '.');
    if (archsForFilesMap.has(baseFile) && archsForFilesMap.get(baseFile).has(arch)) {
      return [];
    }
    if (!archsForFilesMap.has(baseFile)) {
      archsForFilesMap.set(baseFile, new Set([arch]));
    }
    else {
      archsForFilesMap.get(baseFile).add(arch);
    }

    const toFind = new Set();
    ast.body.forEach((node) => {
      if (nodeLoadsFile(node)) {
        toFind.add(node.source.value);
      }
    });
    return Promise.all(Array.from(toFind).map(async (newFile) => {
      const result = await resolveFile(path.join(path.dirname(actualFile), newFile));
      return result;
    }));
  }
  catch (e) {
    errorLog(`problem with file ${absoluteFile} ${actualFile}`);
    throw e;
  }
}
