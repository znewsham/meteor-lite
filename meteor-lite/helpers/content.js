import path from 'path';
import * as acorn from 'acorn';
import fsPromises from 'fs/promises';
import { walk } from 'estree-walker';
import { nodeNameToMeteorName, meteorNameToNodeName } from './helpers.js';
import { acornOptions } from './globals.js';

export async function getExportMainModuleStr(meteorName, mainModule, outputFolder, isCommon) {
  const ast = acorn.parse(
    (await fsPromises.readFile(path.join(outputFolder, mainModule))).toString(),
    acornOptions,
  );
  let hasDefault = false;
  walk(ast, {
    enter(node) {
      if (node.type === 'ExportDefaultDeclaration') {
        hasDefault = true;
      }
      else if (node.type === 'ExportSpecifier' && node.exported.name === 'default' && node.local.name === 'default') {
        hasDefault = true;
      }
    },
  });
  if (isCommon) {
    return [
      `const __package__ = require("${mainModule}");`,
      `Package._define("${meteorName}", { ...__package__ });`,
      'module.exports = __package__;',
    ].join('\n');
  }
  return [
    `import * as __package__ from "${mainModule}";`,
    `Package._define("${meteorName}", { ...__package__ });`,
    `export * from "${mainModule}";`,

    // seriously debatable behaviour - but it will resolve all lib files that import X from "y" where y only provides a server default export
    ...(hasDefault ? [`export { default } from "${mainModule}";`] : ['export default undefined']),
  ].join('\n');
}

export function getExportStr(meteorName, clientOrServer, jsExports, jsImports, isCommon, packageGetter, mainModule) {
  const exportsSet = new Set(jsExports);
  const deps = new Set(Array.from(jsImports)
    .filter((dep) => dep.startsWith('@'))
    .map((dep) => nodeNameToMeteorName(dep)));

  const imported = new Set();
  const importedMap = new Map();
  deps.forEach((dep) => {
    const meteorPackage = packageGetter(dep);
    if (!meteorPackage) {
      // this should only happen for weak imports, and we're not gonna try and fix
      return;
    }
    meteorPackage.getExportedVars(clientOrServer)
      .forEach((imp) => {
        if (exportsSet.has(imp)) {
          if (!imported.has(imp)) {
            if (!importedMap.has(dep)) {
              importedMap.set(dep, new Set());
            }
            importedMap.get(dep).add(imp);
            imported.add(imp);
          }
        }
      });
  });
  const localsToExport = jsExports.filter((exp) => !imported.has(exp));
  let packageDefinition = '';
  if (!isCommon) {
    packageDefinition = mainModule
      ? jsExports.map((exp) => `Package["${meteorName}"].${exp} = ${exp};`).join('\n')
      : `Package._define("${meteorName}", { ${jsExports.join(', ')} });`;
  }
  if (isCommon) {
    if (mainModule) {
      return '';
    }
    return [
      ...(jsExports.length ? ['const __package_globals__ = require("./__globals.js");', `const { ${jsExports} } = __package_globals__;`] : []),
      ...Array.from(importedMap.entries())
        .map(([dep, importSet]) => `const { ${Array.from(importSet).join(', ')} } =  require("${meteorNameToNodeName(dep)}");`),
      ...localsToExport.map((localExport) => `exports.${localExport} = __package_globals__.${localExport};`),
      packageDefinition,
    ].join('\n');
  }

  return [
    ...(localsToExport.length ? ['import __package_globals__ from "./__globals.js"'] : []),
    ...Array.from(importedMap.entries())
      .map(([dep, importSet]) => `import { ${Array.from(importSet).join(', ')} } from "${meteorNameToNodeName(dep)}";`),
    ...mainModule ? localsToExport.map((exp) => `if (!__package_globals__.${exp}) { __package_globals__.${exp} = __package__.${exp}}`) : [],
    localsToExport.length ? `const { ${localsToExport.join(', ')} }  = __package_globals__;` : '',
    `export { ${jsExports.join(', ')} };`,
    ...(mainModule ? [] : ['export default undefined']),
    packageDefinition,
  ].join('\n');
}
