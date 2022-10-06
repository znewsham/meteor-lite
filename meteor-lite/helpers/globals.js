import path from 'path';
import * as acorn from 'acorn';
import * as acornLoose from 'acorn-loose';
import { analyze as analyzeScope } from 'escope';
import { generate } from 'astring';
import { walk } from 'estree-walker';
import fsPromises, { readdir } from 'fs/promises';
import { windowGlobals } from './window-globals.js';
import { nodeNameToMeteorName } from './helpers.js';

export const acornOptions = {
  ecmaVersion: 2022,
  sourceType: 'module',
  allowImportExportEverywhere: true,
  allowAwaitOutsideFunction: true,
};

// some packages may depend on things that meteor sets up as a global.
// let's nip that in the bud.
export const globalStaticImports = new Map([
  ['Meteor', '@meteor/meteor'],
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

export async function replaceGlobalsInFile(outputFolder, globals, file, importedGlobals, isCommon, packageGetter, archs) {
  const multiArch = archs?.length > 1;
  const imports = new Map();
  globals.forEach((global) => {
    let from;
    if (importedGlobals.has(global)) {
      from = importedGlobals.get(global);
    }
    else {
      from = '__globals.js';
    }
    if (!imports.has(from)) {
      imports.set(from, new Set());
    }
    imports.get(from).add(global);
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
        return `import __package_globals__ from "${from}";`;
      }
      const meteorName = nodeNameToMeteorName(from);
      // if this is a common JS module, we don't allow import of @meteor/meteor (hopefully just required for the global)
      // if you're importing something else...we're gonna have to fix by hand.
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
      if (multiArch && !from.match(/^[./]/)) {
        const meteorPackage = packageGetter(meteorName);
        if (!meteorPackage) {
          throw new Error(`importing from missing package ${from}`);
        }
        const exportsForPackageForArchs = archs.map((arch) => meteorPackage.getExportedVars(arch));
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
          rewriteFileForPackageGlobals(fileContents, imports.get('__globals.js')),
        ].join('\n'),
      );
    }
    catch (e) {
      console.log('error with', file);
      throw e;
    }
  }
}

async function getFileList(dirName) {
  let files = [];
  const items = await readdir(dirName, { withFileTypes: true });

  for (const item of items) {
    if (excludeFolders.has(item.name)) {
      continue;
    }
    if (item.isDirectory()) {
      files = [
        ...files,
        ...(await getFileList(path.join(dirName, item.name))),
      ];
    }
    else if (item.name.endsWith('.js') && !excludeFindImports.has(item.name)) {
      files.push(path.join(dirName, item.name));
    }
  }

  return files;
}

function getExportNamedDeclarationNodes(ast) {
  const nodes = [];
  walk(ast, {
    enter(node, parent) {
      if (node.type === 'ExportNamedDeclaration') {
        nodes.push({ node, parent });
      }
    },
  });
  return nodes;
}

function maybeRewriteImportsOrExports(ast) {
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
      const exportNamedDeclarationNodes = getExportNamedDeclarationNodes(ast);
      exportNamedDeclarationNodes.sort((a, b) => b.start - a.start);
      exportNamedDeclarationNodes.forEach(({ node }) => {
        const prefix = contents.slice(0, node.start);
        const declaration = node.specifiers.map((specifier) => {
          const ret = `const _${specifier.local.name} = ${specifier.local.name}`;
          specifier.exported = JSON.parse(JSON.stringify(specifier.local));
          specifier.local.name = `_${specifier.local.name}`;
          return ret;
        }).join('\n');
        const suffix = contents.slice(node.end);
        contents = `${prefix}\n${declaration}\n${generate(node)}\n${suffix}`;
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
    enter(node) {
      if (node.type === 'AssignmentExpression') {
        if (node.left.type === 'MemberExpression' && node.left.object.name === 'exports') {
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
  const { ast, requiresCleaning } = await getCleanAST(file);
  const importEntries = new Map();
  const importReplacementPrefix = '_import_require_';
  let blockDepth = 0;
  let hasImports = false;
  let hasRequires = false;
  let usesExports = false;
  if (!isCommon) {
    walk(ast, {
      leave(node) {
        if (node.type === 'BlockStatement') {
          blockDepth -= 1;
        }
      },
      enter(node) {
        if (node.type === 'AssignmentExpression') {
          if (node.left.type === 'MemberExpression' && node.left.object.name === 'exports') {
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
          if (blockDepth !== 0) {
            hasRequires = true;
            return;
          }
          const importPath = node.arguments[0].value;
          let importEntry;
          if (importEntries.has(importPath)) {
            importEntry = importEntries.get(importPath);
          }
          else {
            const name = `${importReplacementPrefix}_${importEntries.size + 1}`;
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
          node.type = 'Identifier';
          node.name = importEntry.name;
        }
      },
    });
  }
  let exported;
  if (usesExports && !hasRequires) {
    exported = rewriteExports(ast);
    exportedMap.set(file, exported);
  }
  if (requiresCleaning || importEntries.size) {
    importEntries.forEach(({ node }) => {
      ast.body.splice(0, 0, node);
    });
    if (hasRequires && hasImports) {
      throw new Error(`Imports and requires in ${file} (un-fixable)`);
    }
    if (hasRequires && importEntries.size) {
      //throw new Error(`Imports and requires in ${file} (fixable)`);
    }
    await fsPromises.writeFile(file, generate(ast));
  }
}
export async function maybeCleanASTs(folder, isCommon, exportedMap) {
  const files = await getFileList(folder);
  await Promise.all(files.map((file) => {
    try {
      return maybeCleanAST(file, isCommon, exportedMap);
    }
    catch (e) {
      console.log('error with', file);
      throw e;
    }
  }));
}

async function getGlobals(file, map, isCommon) {
  const ast = acorn.parse((await fsPromises.readFile(file)).toString(), acornOptions);
  const hasRewrittenImportsOrExports = maybeRewriteImportsOrExports(ast);
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
  map.set(file, all);
  /*if (requiresCleaning && all.size) {
    map.set(file, all);
    Array.from(all).forEach((packageGlobal) => {
      exportNamedDeclarationNodes.some(({ node, parent }) => {
        const found = node.specifiers.find(({ exported, local }) => exported.name === local.name && exported.name === packageGlobal);
        if (found) {
          found.local.name = `_${packageGlobal}`;
          if (!parent.body) {
            throw new Error('bad parent');
          }
          fixed = true;
          const nodeIndex = parent.body.indexOf(node);
          parent.body.splice(nodeIndex, 0, {
            type: 'VariableDeclaration',
            kind: 'const',
            declarations: [{
              type: 'VariableDeclarator',
              id: {
                type: 'Identifier',
                name: `_${packageGlobal}`,
              },
              init: {
                type: 'Identifier',
                name: packageGlobal,
              },
            }],
          });
          return true;
        }
        return false;
      });
    });
  }*/
  if (hasRewrittenImportsOrExports) {
    await fsPromises.writeFile(file, generate(ast));
  }
}

export async function getPackageGlobals(folder, isCommon) {
  const files = await getFileList(folder);
  const map = new Map();
  await Promise.all(files.map((file) => {
    try {
      return getGlobals(file, map, isCommon);
    }
    catch (e) {
      console.log('error with', file);
      throw e;
    }
  }));
  return map;
}

export function rewriteFileForPackageGlobals(contents, packageGlobalsSet) {
  if (!packageGlobalsSet?.size) {
    return contents;
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
  walk(ast, {
    enter(node) {
      if (/Function/.test(node.type)) {
        currentScope = scopeManager.acquire(node); // get current function scope
      }
    },
    leave(node, parent, prop, index) {
      if (/Function/.test(node.type) || /Class/.test(node.type)) {
        currentScope = currentScope.upper; // set to parent scope
      }
      if (node.type !== 'Identifier' || !packageGlobalsSet.has(node.name)) {
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
        && (parent.type !== 'MemberExpression' || parent.object === node)
        && (parent.type !== 'Property' || parent.value === node)
        && parent.type !== 'PropertyDefinition'
        && parent.type !== 'FunctionExpression'
        && !currentScope.set.has(node.name)
        && !currentScope.through.find((ref) => ref.resolved?.name === node.name)
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
  try {
    return generate(ast);
  }
  catch (error) {
    throw error;
  }
}
