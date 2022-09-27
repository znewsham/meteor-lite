import path from 'path';
import { readdir } from 'fs/promises';
import * as acorn from 'acorn';
import { analyze as analyzeScope } from 'escope';
import { print } from 'recast';
import { walk } from 'estree-walker';
import fsPromises from 'fs/promises';
import { windowGlobals } from './window-globals.js';

const acornOptions = {
  ecmaVersion: 2020,
  sourceType: 'module',
  allowImportExportEverywhere: true,
  allowAwaitOutsideFunction: true
};

// some packages may depend on things that meteor sets up as a global.
// let's nip that in the bud.
export const globalStaticImports = new Map([
  ['Meteor', '@meteor/meteor']
]);

const excludeFindImports = new Set([
  'package.js',
  '__client.js',
  '__server.js',
  '__globals.js',
  '__client_module.js',
  '__server_module.js'
]);


function getOwnPropertyNames() {
  return Object.getOwnPropertyNames(this || global);
}

const commonJSBlacklist = new Set([
  'exports',
  'module',
  'require'
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
  ...getOwnPropertyNames()
]);

globalBlacklist.delete('global'); // meteor does some fuckery here

const excludeFolders = new Set(['.npm', 'node_modules']);

export async function replaceGlobalsInFile(outputParentFolder, globals, file, importedGlobals, isCommon, packageGetter) {
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
    const importStr = Array.from(imports.entries()).map(([from, imports], i) => {
      if (from === '__globals.js') {
        const relative = file.replace(outputParentFolder.replace("./", ""), "").split('/').slice(2).map(a => '..').join('/');
        from = `./${relative}${relative && '/'}__globals.js`;
        if (isCommon) {
          return `const __package_globals__ = require("${from}");`
        }
        else {
          // get the relative path of __globals.js
          return `import __package_globals__ from "${from}";`;
        }
      }
      const meteorName = from.replace('@meteor/', '');
      // if this is a common JS module, we don't allow import of @meteor/meteor (hopefully just required for the global)
      // if you're importing something else...we're gonna have to fix by hand.
      if (isCommon) {
        if (from === '@meteor/meteor' && imports.has('global') && imports.size === 1) {
          return `const { ${Array.from(imports).join(', ')} } = require("${from}/global.cjs");`
        }
        else if (packageGetter(meteorName).isCommon()) {
          return `const { ${Array.from(imports).join(', ')} } = require("${from}");`
        }
        else {
          throw new Error(`Can't import ESM meteor package ${from} from commonjs meteor package ${file}`);
        }
      }
      else if (meteorName && packageGetter(meteorName).isCommon()) {
        return [
          `import __import__${i}__ from "${from}";`,
          `const { ${Array.from(imports).join(', ')} } = __import__${i}__;`
        ].join('\n');
      }
      else {
        return `import { ${Array.from(imports).join(', ')} } from "${from}";`;
      }
    }).join('\n');
    try {
      await fsPromises.writeFile(
        file,
        [
          importStr,
          rewriteFileForPackageGlobals(fileContents, imports.get('__globals.js'))
        ].join('\n')
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
    } else if (item.name.endsWith('.js') && !excludeFindImports.has(item.name)) {
      files.push(path.join(dirName, item.name));
    }
  }

  return files;
}

async function getGlobals(file, map, isCommon) {
  const ast = acorn.parse(
    (await fsPromises.readFile(file)).toString(),
    acornOptions
  );
  const scopeManager = analyzeScope(ast, {
    ecmaVersion: 6,
    sourceType: "module",
    ignoreEval: true,
    // Ensures we don't treat top-level var declarations as globals.
    nodejsScope: true,
  });
  const currentScope = scopeManager.acquire(ast);
  const all = new Set([
    ...currentScope.implicit.variables.map(entry => entry.identifier.name), 
    ...currentScope.implicit.left.filter(entry => entry.identifier &&
      entry.identifier.type === "Identifier").map(entry => entry.identifier.name)
  ].filter(name => {
    if (globalBlacklist.has(name)) {
      return false;
    }
    if (isCommon && commonJSBlacklist.has(name)) {
      return false;
    } 
    return true;
  }));
  if (all.size) {
    map.set(file, all);
  } 
}

export async function getPackageGlobals(folder, isCommon) {
  const files = await getFileList(folder);
  const map = new Map();
  await Promise.all(files.map(file => {
    try {
      return getGlobals(file, map, isCommon);
    }
    catch (e) {
      console.log("error with", file);
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
    acornOptions
  );
  const scopeManager = analyzeScope(ast, {
    ecmaVersion: 6,
    sourceType: "module",
    ignoreEval: true,
    // Ensures we don't treat top-level var declarations as globals.
    nodejsScope: true,
  });
  let currentScope = scopeManager.acquire(ast);
  walk(ast, {
    enter(node) {
      if (/Function/.test(node.type)) {
        currentScope = scopeManager.acquire(node);  // get current function scope
      }
    },
    leave(node, parent, prop, index) {
      if (/Function/.test(node.type)) {
        currentScope = currentScope.upper;  // set to parent scope
      }
      if (
        node.type === 'Identifier'
        && parent.type !== 'VariableDeclarator'
        && (parent.type !== 'MemberExpression' || parent.object === node)
        && parent.type !== 'Property'
        && packageGlobalsSet.has(node.name)
        && !currentScope.set.has(node.name)
        && !currentScope.through.find(ref => ref.resolved?.name === node.name)
      ) {
        node.__rewritten = true;
        node.type = 'MemberExpression';
        node.object = {
          type: 'Identifier',
          name: '__package_globals__'
        };
        node.property = {
          type: 'Identifier',
          name: node.name
        }
      }
    }
  });
  return print(ast).code;
}
