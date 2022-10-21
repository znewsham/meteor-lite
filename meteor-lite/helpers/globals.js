import path from 'path';
import * as acorn from 'acorn';
import * as acornLoose from 'acorn-loose';
import { analyze as analyzeScope } from 'escope';
import { generate } from 'astring';
import { walk } from 'estree-walker';
import fsPromises, { readdir } from 'fs/promises';
import { windowGlobals } from './window-globals.js';
import { meteorNameToNodeName, nodeNameToMeteorName } from './helpers.js';
import { getImportTreeForFile, resolveFile } from './imports.js';

export const acornOptions = {
  ecmaVersion: 2022,
  sourceType: 'module',
  allowImportExportEverywhere: true,
  allowAwaitOutsideFunction: true,
};

// some packages may depend on things that meteor sets up as a global.
// let's nip that in the bud.
// TODO: remove
export const globalStaticImports = new Map([
  ['Meteor', '@meteor/meteor'],
  ['global', '@meteor/meteor'],
]);

const excludeFindImports = new Set([
  'package.js',
  '__client.js',
  '__server.js',
  '__globals.js',
  '__client_module.js',
  '__server_module.js',
  '__client_assets.js',
  '__server_assets.js',
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
  'runTests', // meteor expects test drivers to expose a global `runTests`
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

const excludeFolders = new Set(['.npm', 'node_modules']);

// super gnarly bandaid solution, just to test if the "globals are only package globals if they're assigned"
// we treat all these as package globals.
const BAD = new Set(['exports', 'module', 'require', 'Npm', 'Assets']);

const SERVER_ONLY_IMPORTS = new Set([
  'fibers',
  'util',
]);

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
  const isClientArch = archs && (archs.has('client') || Array.from(archs).find((arch) => arch.startsWith('web.')));
  const isServerArch = archs && archs.has('server');
  const isClientServerArch = isClientArch && isServerArch;
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
      // TODO: this is weird
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
    const importStr = Array.from(imports.entries()).map(([from, fromImports], i) => {
      if (from === '__globals.js') {
        const relative = path.resolve(file).replace(outputFolder, '').split('/').slice(2)
          .map((a) => '..')
          .join('/');
        from = `./${relative}${relative && '/'}__globals.js`;
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

function getExportNamedDeclarationNodes(ast) {
  const nodes = [];
  walk(ast, {
    enter(node, parent) {
      if (node.type === 'ExportNamedDeclaration') {
        nodes.push({ node, parent, type: 'export' });
      }
    },
  });
  return nodes;
}

function maybeRewriteAwait(ast, infoOnly, debug) {
  let ret = false;
  walk(ast, {
    enter(node) {
      // require('meteor/whatever')
      if (
        node.type === 'AwaitExpression'
      ) {
        ret = true;
        if (!infoOnly) {
          node.__rewritten = true;
          node.type = 'CallExpression';
          node.callee = {
            type: 'MemberExpression',
            object: {
              type: 'Identifier',
              name: 'Promise',
            },
            property: {
              type: 'Identifier',
              name: 'await',
            },
          };
          node.arguments = [node.argument];
        }
      }
    },
  });
  return ret;
}

function maybeRewriteRequire(ast, debug) {
  let ret = false;
  walk(ast, {
    enter(node) {
      // require('meteor/whatever')
      if (
        node.type === 'CallExpression'
        && node.callee.type === 'Identifier'
        && node.callee.name === 'require'
        && node.arguments.length === 1
        && node.arguments[0].type === 'Literal'
        && node.arguments[0].value.startsWith('meteor/')
      ) {
        ret = true;
        node.__rewritten = true;
        if (node.arguments[0].value.includes(':')) {
          node.arguments[0].value = `@${node.arguments[0].value.replace('meteor/', '').split(':').join('/')}`;
        }
        else {
          node.arguments[0].value = `@${node.arguments[0].value}`;
        }
        node.arguments[0].raw = `"${node.arguments[0].value}"`;
      }
    },
  });
  return ret;
}

const contextChangingTypes = new Set([
  'ArrowFunctionExpression',
  'FunctionExpression',
  'FunctionDeclaration',
  // TODO: where else would `this` be valid?
]);
function maybeRewriteGlobalThis(ast, debug) {
  let ret = false;
  const currentContext = [ast];
  walk(ast, {
    enter(node) {
      if (contextChangingTypes.has(node.type)) {
        currentContext.push(node);
      }
      if (node.type === 'ThisExpression' && currentContext.length === 1) {
        node.__rewritten = true;
        node.type = 'Identifier';
        node.name = 'globalThis';
        ret = true;
      }
    },
    leave(node) {
      if (currentContext[currentContext.length - 1] === node) {
        currentContext.pop();
      }
    },
  });
  return ret;
}

function maybeRewriteImportsOrExports(ast, debug) {
  // TODO export from
  let ret = false;
  walk(ast, {
    enter(node) {
      if (node.type === 'ImportDeclaration' && node.source.value.startsWith('meteor/')) {
        ret = true;
        if (node.source.value.includes(':')) {
          node.source.value = `@${node.source.value.replace('meteor/', '').split(':').join('/')}`;
          node.source.raw = `'${node.source.value}'`;
        }
        else {
          node.source.value = `@${node.source.value}`;
          node.source.raw = `'${node.source.value}'`;
        }
      }
    },
  });

  return ret;
}

const reservedKeywords = new Set(['package', 'public']);

function fixReservedUsage(ast) {
  const packageNodes = [];
  walk(ast, {
    enter(node, parent) {
      if (node.type === 'Identifier' && reservedKeywords.has(node.name)) {
        packageNodes.push({ node, parent, type: 'reserved' });
      }
    },
  });
  return packageNodes;
}

async function getCleanAST(file) {
  try {
    let contents = (await fsPromises.readFile(file)).toString();
    let ast;
    try {
      ast = acorn.parse(
        contents,
        acornOptions,
      );
      return { ast, requiresCleaning: false };
    }
    catch (e) {
      // acorn-loose incorrectly parses things that acorn can parse correctly (wildly)
      // an example is qualia:core/lib/helpers.js where daysBetweenUsing365DayYear gets "replaced" with a unicode X
      // so if we fail to parse with acorn, we parse with acornLoose and manually fix the exported globals (hopefully the reason)
      // then re-parse with acorn.
      ast = acornLoose.parse(
        contents,
        acornOptions,
      );
      const all = [
        ...fixReservedUsage(ast),
        ...getExportNamedDeclarationNodes(ast),
      ];
      all.sort((a, b) => b.node.start - a.node.start);
      all.forEach(({ node, type }) => {
        const prefix = contents.slice(0, node.start);
        const suffix = contents.slice(node.end);
        if (type === 'export') {
          const declaration = node.specifiers.map((specifier) => {
            const ret = `const _${specifier.local.name} = ${specifier.local.name}`;
            specifier.exported = JSON.parse(JSON.stringify(specifier.local));
            specifier.local.name = `_${specifier.local.name}`;
            return ret;
          }).join('\n');
          contents = `${prefix}\n${declaration}\n${generate(node)}\n${suffix}`;
        }
        else if (type === 'reserved') {
          contents = `${prefix}___${node.name}${suffix}`;
        }
      });
      ast = acorn.parse(
        contents,
        acornOptions,
      );
      return { ast, requiresCleaning: true };
    }
  }
  catch (e) {
    console.log('problem with file', file);
    throw e;
  }
}

function rewriteExports(ast) {
  const exported = [];
  walk(ast, {
    enter(node, parent) {
      if (parent?.type === 'AssignmentExpression' || parent?.type === 'VariableDeclarator') {
        return;
      }
      if (node.type === 'AssignmentExpression') {
        if (
          node.left.type === 'MemberExpression'
          && node.left.object.name === 'module'
          && node.left.property.name === 'exports'
        ) {
          node.__rewritten = true;
          node.type = 'ExportDefaultDeclaration';
          node.declaration = node.right;
          exported.push(null);
        }
        else if (
          node.left.type === 'MemberExpression'
          && (
            node.left.object.name === 'exports'
            || (
              node.left.object.type === 'MemberExpression'
              && node.left.object.object.name === 'module'
              && node.left.object.property.name === 'exports'
            )
          )
        ) {
          node.__rewritten = true;
          node.type = 'ExportNamedDeclaration';
          exported.push(node.left.property.name);
          if (node.left.property.name === node.right.name) {
            node.specifiers = [{
              type: 'ExportSpecifier',
              exported: {
                type: 'Identifier',
                name: node.right.name,
              },
              local: {
                type: 'Identifier',
                name: node.right.name,
              },
            }];
          }
          else {
            node.declaration = {
              type: 'VariableDeclaration',
              kind: 'var',
              declarations: [{
                type: 'VariableDeclarator',
                id: {
                  type: 'Identifier',
                  name: node.left.property.name,
                },
                init: node.right,
              }],
            };
          }
        }
      }
    },
  });

  return exported;
}

async function maybeCleanAST(file, isCommon, exportedMap) {
  if (!file.endsWith('.js')) {
    const resolvedFile = await resolveFile(file);
    if (!resolvedFile.endsWith('.js')) { // TODO: ts
      return;
    }
  }
  const { ast, requiresCleaning } = await getCleanAST(file);
  const importEntries = new Map();
  const importReplacementPrefix = '_import_require_';
  let blockDepth = 0;
  let hasImports = false;
  let hasRequires = false;
  let usesExports = false;
  let usesUncleanExports = false;
  if (!isCommon) {
    walk(ast, {
      leave(node) {
        if (node.type === 'BlockStatement') {
          blockDepth -= 1;
        }
      },
      enter(node) {
        if (node.type === 'AssignmentExpression') {
          if (
            node.left.type === 'MemberExpression'
            && (
              node.left.object.name === 'exports'
              || (node.left.object.type === 'MemberExpression' && node.left.object.object.name === 'module' && node.left.object.property.name === 'exports')
            )
          ) {
            if (!usesUncleanExports) {
              usesUncleanExports = blockDepth !== 0;
            }
            usesExports = true;
          }
        }
        if (node.type === 'BlockStatement') {
          blockDepth += 1;
        }
        if (node.type === 'ImportDeclaration') {
          hasImports = true;
        }
        if (
          node.type === 'CallExpression'
          && node.callee.type === 'Identifier'
          && node.callee.name === 'require'
          && node.arguments.length === 1
          && node.arguments[0].type === 'Literal'
        ) {
          if (blockDepth !== 0 || isCommon) {
            hasRequires = true;
            return;
          }
          const importPath = node.arguments[0].value;
          let importEntry;
          if (importEntries.has(importPath)) {
            importEntry = importEntries.get(importPath);
          }
          else {
            const name = `${importReplacementPrefix}${importEntries.size + 1}`;
            importEntry = {
              name,
              node: {
                type: 'ImportDeclaration',
                source: {
                  type: 'Literal',
                  value: node.arguments[0].value,
                  raw: node.arguments[0].raw,
                },
                specifiers: [{
                  type: 'ImportNamespaceSpecifier',
                  local: {
                    type: 'Identifier',
                    name,
                  },
                }],
              },
            };
            importEntries.set(importPath, importEntry);
          }
          node.__rewritten = true;
          node.type = 'LogicalExpression';
          node.operator = '||';
          node.right = {
            type: 'Identifier',
            name: importEntry.name,
          };
          node.left = {
            type: 'MemberExpression',
            object: {
              type: 'Identifier',
              name: importEntry.name,
            },
            property: {
              type: 'Identifier',
              name: 'default',
            },
          };
        }
      },
    });
  }
  let exported;
  let importAstBodyIndex = 0;
  if (usesExports && !hasRequires && !usesUncleanExports) {
    exported = rewriteExports(ast);
    exportedMap.set(file, exported);
  }
  if (requiresCleaning || importEntries.size || exported?.length) {
    importEntries.forEach(({ node }) => {
      ast.body.splice(importAstBodyIndex++, 0, node);
    });
    if (hasRequires && hasImports) {
      throw new Error(`Imports and requires in ${file} (un-fixable)`);
    }
    if (hasRequires && importEntries.size) {
      //throw new Error(`Imports and requires in ${file} (fixable)`);
    }
    await fsPromises.writeFile(file, generate(ast));
  }
  return ast;
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
  const ast = acorn.parse(fileContents, acornOptions);
  const hasRewrittenImportsOrExports = maybeRewriteImportsOrExports(ast);
  const hasRewrittenRequires = false && maybeRewriteRequire(ast, debug);
  const hasGlobalThis = maybeRewriteGlobalThis(ast);
  let hasRewrittenAwait = false;
  if (archsForFile.has('server')) {
    hasRewrittenAwait = maybeRewriteAwait(ast, archsForFile.size !== 1);
    if (hasRewrittenAwait && archsForFile.size !== 1) {
      console.warn(`file ${file} used on both client and server required Promise.await conversion, this probably isn't gonna work (we left it alone)`);
    }
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
    await fsPromises.writeFile(file, generate(ast));
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

// TODO - do a better job figuring out server/client only imports (static analysis?)
function replaceImportsInAst(ast, isMultiArch, serverOnlyImportsSet, file) {
  if (!isMultiArch) {
    // if we're not multi-arch, don't bother rewriting.
    return;
  }
  walk(ast, {
    enter(node) {
      if (node.type === 'ImportDeclaration') {
        const rootImportSource = node.source.value.split('/')[0];
        if (SERVER_ONLY_IMPORTS.has(rootImportSource)) {
          node.__rewritten = true;
          if (rootImportSource !== node.source.value) {
            serverOnlyImportsSet.add(`${rootImportSource}/*`);
          }
          else {
            serverOnlyImportsSet.add(rootImportSource);
          }
          node.source.value = `#${node.source.value}`;
          node.source.raw = `'${node.source.value}'`;
        }
      }
    },
  });
}

export function rewriteFileForPackageGlobals(contents, packageGlobalsSet, isMultiArch, serverOnlyImportsSet, file) {
  if (!packageGlobalsSet?.size) {
    packageGlobalsSet = new Set();
    // no short circuting, we need to handle serverOnlyImports too :'(
    // return contents;
  }
  const ast = acorn.parse(
    contents,
    acornOptions,
  );
  const scopeManager = analyzeScope(ast, {
    ecmaVersion: 6,
    sourceType: 'module',
    ignoreEval: true,
    // Ensures we don't treat top-level var declarations as globals.
    nodejsScope: true,
  });
  let currentScope = scopeManager.acquire(ast);
  let stack = [];
  const acquired = new Set();
  replaceImportsInAst(ast, isMultiArch, serverOnlyImportsSet, file);
  walk(ast, {
    enter(node) {
      stack.push(node);
      if (scopeManager.acquire(node)) {
        acquired.add(node);
        currentScope = scopeManager.acquire(node); // get current function scope
      }
    },
    leave(node, parent, prop, index) {
      stack.pop();
      if (acquired.has(node)) {
        acquired.delete(node);
        currentScope = currentScope.upper; // set to parent scope
      }
      if (
        node.type !== 'Identifier'
        || !packageGlobalsSet.has(node.name)
        || currentScope.set.has(node.name)
        || currentScope.through.find((ref) => ref.resolved?.name === node.name)
      ) {
        return;
      }

      if (parent.type === 'Property' && parent.shorthand && parent.value === node) {
        parent.key = JSON.parse(JSON.stringify(parent.key));
        parent.shorthand = false;
        node.__rewritten = true;
        parent.__rewritten = true;
        node.type = 'MemberExpression';
        node.object = {
          type: 'Identifier',
          name: '__package_globals__',
        };
        node.property = {
          type: 'Identifier',
          name: node.name,
        };
        return;
      }
      // simple rewrite
      if (
        (parent.type !== 'VariableDeclarator' || parent.id !== node)
        && (parent.type !== 'MemberExpression' || parent.object === node || parent.computed === true)
        && (parent.type !== 'Property' || parent.value === node)
        && parent.type !== 'CatchClause'
        && parent.type !== 'ObjectPattern'
        && parent.type !== 'PropertyDefinition'
        && (parent.type !== 'FunctionExpression' || node === parent.left)
        && (parent.type !== 'FunctionDeclaration' || node === parent.id)
      ) {
        node.__rewritten = true;
        node.type = 'MemberExpression';
        node.object = {
          type: 'Identifier',
          name: '__package_globals__',
        };
        node.property = {
          type: 'Identifier',
          name: node.name,
        };
      }
    },
  });
  return generate(ast);
}
