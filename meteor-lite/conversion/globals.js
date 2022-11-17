import path from 'path';
import { analyze as analyzeScope } from 'escope';
import fsPromises from 'fs/promises';
import { windowGlobals } from './window-globals.js';
import { nodeNameToMeteorName } from '../helpers/helpers.js';
import { getImportTreeForFile } from './imports.js';
import maybeRewriteImportsOrExports from './ast/rewrite/import-meteor.js';
import maybeRewriteRequire from './ast/rewrite/require.js';
import maybeRewriteGlobalThis from './ast/rewrite/global-this.js';
import maybeRewriteAwait from './ast/rewrite/await.js';
import { astToCode, maybeCleanAST, parseContentsToAST } from './ast/index.js';
import rewriteASTForPackageGlobals from './ast/rewrite/package-globals.js';
import replaceImportsInAst from './ast/rewrite/replace-imports';

export const generateOptions = {
  comments: true,
};

// some packages may depend on things that meteor sets up as a global.
// let's nip that in the bud.
// TODO: remove
export const globalStaticImports = new Map([
  ['Meteor', '@meteor/meteor'],
  ['global', '@meteor/meteor'],
]);

function getOwnPropertyNames() {
  return Object.getOwnPropertyNames(this || global);
}

const commonJSBlacklist = new Set([
  'exports',
  'module',
  'require',
]);

// QUESTION: if we ever have a package that exports a global with the same name as a "global" - what do we do, see the deletion below as an example
// it's possible we don't need this anymore due to how we detect package global usage
const globalBlacklist = new Set([
  'revalify',
  'window',
  'document',
  'navigator',
  'jQuery',
  '$',
  ...windowGlobals,
  '__meteor_runtime_config__',
  '__meteor_bootstrap__',
  'Package', // meteor defines this on a package global called global, which is initted to the actual global. So Package is available everywhere
  ...getOwnPropertyNames(),
]);

globalBlacklist.delete('global'); // the meteor package does weirdness here - it exports a global called global

// super gnarly bandaid solution, just to test if the "globals are only package globals if they're assigned"
// we treat all these as package globals.
const BAD = new Set(['exports', 'module', 'require', 'Npm', 'Assets']);


function getImportStr(
  imports,
  isMultiArch,
  outputFolder,
  file,
  isCommon,
  packageGetter,
  archs,
) {
  return Array.from(imports.entries())
    .map(([from, fromImports]) => {
      // find the correct path to the __globals.js file in the case that a folder in a package is trying to use a package global
      let fromToUse = from;
      if (fromToUse === '__globals.js') {
        const relative = path.resolve(file).replace(outputFolder, '').split('/').slice(2)
          .map(() => '..')
          .join('/');
        fromToUse = `./${relative}${relative && '/'}__globals.js`;
      }
      return [fromToUse, fromImports];
    })
    .map(([from, fromImports], i) => {
      if (from.endsWith('__globals.js')) {
        if (isCommon) {
          return `const __package_globals__ = require("${from}");`;
        }

        // get the relative path of __globals.js
        return `import __package_globals__ from "${from}";`;
      }
      const meteorName = nodeNameToMeteorName(from);
      const meteorPackage = packageGetter(meteorName);
      if (!meteorPackage) {
        throw new Error(`${meteorName} does not exist`);
      }
      if (isCommon) {
        return `const { ${Array.from(fromImports).join(', ')} } = require("${from}");`;
      }
      if (meteorName && meteorPackage.isCommon()) {
        return [
          `import __import__${i}__ from "${from}";`,
          `const { ${Array.from(fromImports).join(', ')} } = __import__${i}__;`,
        ].join('\n');
      }

      let useGnarly = false;
      if (isMultiArch && !from.match(/^[./]/)) {
        if (!meteorPackage) {
          throw new Error(`importing from missing package ${from}`);
        }
        const exportsForPackageForArchs = Array.from(archs).map((arch) => meteorPackage.getExportedVars(arch));
        const fromImportsArray = Array.from(fromImports);
        useGnarly = !fromImportsArray.every((importName) => exportsForPackageForArchs.every((exportsForPackageForArch) => exportsForPackageForArch.includes(importName)))
      }
      if (useGnarly) {
        return [
          `import * as __import__${i}__ from "${from}";`,
          `const { ${Array.from(fromImports).join(', ')} } = __import__${i}__;`,
        ].join('\n');
      }
      return `import { ${Array.from(fromImports).join(', ')} } from "${from}";`;
    }).join('\n');
}

export async function replaceGlobalsInFile(
  outputFolder,
  globals,
  file,
  importedGlobalsByArchMaps,
  isCommon,
  packageGetter,
  archs,
  packageGlobalsSet,
  serverOnlyImportsSet,
  ast,
) {
  const isMultiArch = archs?.size > 1;
  const archName = archs?.size === 1 ? Array.from(archs)[0] : undefined;
  const imports = new Map();
  const findArchForGlobal = (global) => {
    const actualArch = Object.values(importedGlobalsByArchMaps).find((archMap) => archMap.has(global));
    return actualArch;
  };
  globals.forEach((global) => {
    let from;
    if (importedGlobalsByArchMaps[archName]) {
      if (importedGlobalsByArchMaps[archName].has(global) && !packageGlobalsSet.has(global)) {
        from = importedGlobalsByArchMaps[archName].get(global);
      }
      else {
        from = '__globals.js';
      }
    }
    else if (findArchForGlobal(global) && !packageGlobalsSet.has(global)) {
      from = findArchForGlobal(global).get(global);
    }
    else {
      from = '__globals.js';
    }
    if (!imports.has(from)) {
      imports.set(from, new Set());
    }
    if (from !== '__globals.js' && !packageGlobalsSet.has(global)) {
      imports.get(from).add(global);
    }
    else if (from === '__globals.js' && (packageGlobalsSet.has(global) || BAD.has(global))) {
      imports.get(from).add(global);
    }
  });
  if (imports.size) {
    const importStr = getImportStr(
      imports,
      isMultiArch,
      outputFolder,
      file,
      isCommon,
      packageGetter,
      archs,
    );
    try {
      replaceImportsInAst(ast, isMultiArch, serverOnlyImportsSet, file);
      rewriteASTForPackageGlobals(ast, imports.get('__globals.js') || new Set());
      await fsPromises.writeFile(
        file,
        [
          importStr,
          astToCode(ast),
        ].join('\n'),
      );
    }
    catch (e) {
      console.log('error with', file);
      throw e;
    }
  }
}

async function maybeCleanAndGetImportTreeForSingleFile(
  baseFolder,
  file,
  arch,
  archsForFiles,
  isCommon,
  exportedMap,
  astForFiles,
) {
  const baseFile = file.replace(baseFolder, '.');
  if (astForFiles.has(baseFile)) {
    return [];
  }
  if (file.endsWith('.html') || file.endsWith('.css')) {
    return [];
  }
  const ast = await maybeCleanAST(baseFolder, file, isCommon, exportedMap);
  astForFiles.set(baseFile, ast);
  const newFiles = await getImportTreeForFile(
    baseFolder,
    file,
    arch,
    archsForFiles,
    ast,
  );
  return newFiles;
}

async function maybeCleanAndGetImportTreeForArch(
  outputFolder,
  entryPointsForArch,
  arch,
  archsForFiles,
  isCommon,
  exportedMap,
  astForFiles,
) {
  const queue = [...entryPointsForArch];
  while (queue.length !== 0) {
    const items = queue.splice(0, queue.length);

    // eslint-disable-next-line
    await Promise.all(items.map(async (file) => {
      if (!file) {
        return false;
      }
      const newFiles = await maybeCleanAndGetImportTreeForSingleFile(
        outputFolder,
        file,
        arch,
        archsForFiles,
        isCommon,
        exportedMap,
        astForFiles,
      );
      queue.push(...newFiles);
    }));
  }
}

export async function getImportTreeForPackageAndClean(
  outputFolder,
  entryPointsForArch,
  archName,
  archsForFiles,
  isCommon,
  exportedMap,
  astForFiles,
) {
  return maybeCleanAndGetImportTreeForArch(
    outputFolder,
    entryPointsForArch,
    archName,
    archsForFiles,
    isCommon,
    exportedMap,
    astForFiles,
  );
}

function getGlobalsFromScope(isCommon, currentScope, writeOnly = false) {
  return new Set([
    ...currentScope.implicit.variables.map((entry) => entry.identifier.name),
    ...currentScope.implicit.left
      .filter((entry) => entry.identifier
        && entry.from.type !== 'class'
        && entry.identifier.type === 'Identifier'
        && (!writeOnly || entry.writeExpr))
      .map((entry) => entry.identifier.name),
  ].filter((name) => {
    if (globalBlacklist.has(name)) {
      return false;
    }
    if (isCommon && commonJSBlacklist.has(name)) {
      return false;
    }
    return true;
  }));
}

async function getGlobals(
  file,
  map,
  assignedMap,
  isCommon,
  archsForFile,
  ast,
) {
  maybeRewriteImportsOrExports(ast);
  maybeRewriteRequire(ast);
  maybeRewriteGlobalThis(ast);
  if (archsForFile.has('server')) {
    maybeRewriteAwait(ast, archsForFile.size !== 1);
  }
  const scopeManager = analyzeScope(ast, {
    ecmaVersion: 2022,
    sourceType: 'module',
    ignoreEval: true,
    // Ensures we don't treat top-level var declarations as globals.
    nodejsScope: true,
  });
  const currentScope = scopeManager.acquire(ast);
  const all = getGlobalsFromScope(isCommon, currentScope);
  const assigned = getGlobalsFromScope(isCommon, currentScope, true);
  map.set(file, all);
  assignedMap.set(file, assigned);
  await fsPromises.writeFile(file, astToCode(ast));
}

export async function getPackageGlobals(
  isCommon,
  outputFolder,
  archsForFiles,
  asts,
) {
  const map = new Map();
  const assignedMap = new Map();
  const files = Array.from(archsForFiles.keys());
  await Promise.all(files.map((file) => {
    try {
      return getGlobals(
        path.join(outputFolder, file),
        map,
        assignedMap,
        isCommon,
        archsForFiles.get(file),
        asts.get(file),
      );
    }
    catch (e) {
      console.log('error with', file);
      throw e;
    }
  }));
  return { all: map, assigned: assignedMap };
}
