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

globalBlacklist.delete('global'); // meteor does some fuckery here

// super gnarly bandaid solution, just to test if the "globals are only package globals if they're assigned"
// we treat all these as package globals.
const BAD = new Set(['exports', 'module', 'require', 'Npm', 'Assets']);

export function rewriteFileForPackageGlobals(contents, _packageGlobalsSet, isMultiArch, serverOnlyImportsSet, file) {
  const packageGlobalsSet = _packageGlobalsSet || new Set();
  const ast = parseContentsToAST(
    contents,
    {
      attachComments: true,
    },
  );
  rewriteASTForPackageGlobals(ast, packageGlobalsSet, isMultiArch, serverOnlyImportsSet, file);
  return astToCode(ast);
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
    const fileContents = (await fsPromises.readFile(file)).toString();
    const importStr = Array.from(imports.entries())
      .map(([from, fromImports]) => {
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
          return [
            `import __package_globals__ from "${from}";`,
            // MUST be var or let.
            // `var { ${Array.from(fromImports).join(',')} } = __package_globals__;`,
          ].join('\n');
        }
        const meteorName = nodeNameToMeteorName(from);
        // if this is a common JS module, we don't allow import of @meteor/meteor (hopefully just required for the global)
        // if you're importing something else...we're gonna have to fix by hand.
        if (!packageGetter(meteorName)) {
          throw new Error(`${meteorName} does not exist`);
        }
        if (isCommon) {
          if (packageGetter(meteorName).isCommon()) {
            return `const { ${Array.from(fromImports).join(', ')} } = require("${from}");`;
          }

          return `const { ${Array.from(fromImports).join(', ')} } = require("${from}");`;
        }
        if (meteorName && packageGetter(meteorName).isCommon()) {
          return [
            `import __import__${i}__ from "${from}";`,
            `const { ${Array.from(fromImports).join(', ')} } = __import__${i}__;`,
          ].join('\n');
        }

        let useGnarly = false;
        if (isMultiArch && !from.match(/^[./]/)) {
          const meteorPackage = packageGetter(meteorName);
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
    try {
      await fsPromises.writeFile(
        file,
        [
          importStr,
          rewriteFileForPackageGlobals(fileContents, imports.get('__globals.js'), isMultiArch, serverOnlyImportsSet, file),
        ].join('\n'),
      );
    }
    catch (e) {
      console.log('error with', file);
      throw e;
    }
  }
}

async function maybeCleanAndGetImportTreeForSingleFile(outputFolder, file, arch, archsForFiles, isCommon, exportedMap, processedSet) {
  if (processedSet.has(file)) {
    return [];
  }
  processedSet.add(file);
  if (file.endsWith('.html') || file.endsWith('.css')) {
    return [];
  }
  const ast = await maybeCleanAST(file, isCommon, exportedMap);
  const newFiles = await getImportTreeForFile(
    outputFolder,
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
) {
  const processedSet = new Set([]);
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
        processedSet,
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
) {
  return maybeCleanAndGetImportTreeForArch(
    outputFolder,
    entryPointsForArch,
    archName,
    archsForFiles,
    isCommon,
    exportedMap,
  );
}

async function getGlobals(file, map, assignedMap, isCommon, archsForFile) {
  const fileContents = (await fsPromises.readFile(file)).toString();
  const ast = parseContentsToAST(
    fileContents,
    {
      file,
      attachComments: true,
    },
  );
  const hasRewrittenImportsOrExports = maybeRewriteImportsOrExports(ast);
  const hasRewrittenRequires = maybeRewriteRequire(ast);
  const hasGlobalThis = maybeRewriteGlobalThis(ast);
  let hasRewrittenAwait = false;
  if (archsForFile.has('server')) {
    hasRewrittenAwait = maybeRewriteAwait(ast, archsForFile.size !== 1);
  }
  const scopeManager = analyzeScope(ast, {
    ecmaVersion: 2022,
    sourceType: 'module',
    ignoreEval: true,
    // Ensures we don't treat top-level var declarations as globals.
    nodejsScope: true,
  });
  const currentScope = scopeManager.acquire(ast);
  const all = new Set([
    ...currentScope.implicit.variables.map((entry) => entry.identifier.name),
    ...currentScope.implicit.left.filter((entry) => entry.identifier
      && entry.from.type !== 'class'
      && entry.identifier.type === 'Identifier').map((entry) => entry.identifier.name),
  ].filter((name) => {
    if (globalBlacklist.has(name)) {
      return false;
    }
    if (isCommon && commonJSBlacklist.has(name)) {
      return false;
    }
    return true;
  }));

  const assigned = new Set([
    ...currentScope.implicit.variables.map((entry) => entry.identifier.name),
    ...currentScope.implicit.left.filter((entry) => entry.identifier
      && entry.from.type !== 'class'
      && entry.identifier.type === 'Identifier'
      && entry.writeExpr).map((entry) => entry.identifier.name),
  ].filter((name) => {
    if (globalBlacklist.has(name)) {
      return false;
    }
    if (isCommon && commonJSBlacklist.has(name)) {
      return false;
    }
    return true;
  }));
  map.set(file, all);
  assignedMap.set(file, assigned);
  if (hasRewrittenImportsOrExports || hasRewrittenRequires || hasRewrittenAwait || hasGlobalThis) {
    await fsPromises.writeFile(file, astToCode(ast));
  }
}

export async function getPackageGlobals(isCommon, outputFolder, archsForFiles) {
  const map = new Map();
  const assignedMap = new Map();
  const files = Array.from(archsForFiles.keys());
  await Promise.all(files.map((file) => {
    try {
      return getGlobals(path.join(outputFolder, file), map, assignedMap, isCommon, archsForFiles.get(file));
    }
    catch (e) {
      console.log('error with', file);
      throw e;
    }
  }));
  return { all: map, assigned: assignedMap };
}
