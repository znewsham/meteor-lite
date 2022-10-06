import path from 'path';
import * as acorn from 'acorn';
import fsPromises from 'fs/promises';
import { walk } from 'estree-walker';
import { nodeNameToMeteorName, meteorNameToNodeName } from './helpers.js';
import { acornOptions } from './globals.js';

export async function getExportMainModuleStr(meteorName, mainModule, outputFolder) {
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
    },
  });
  return [
    `import * as __package__ from "${mainModule}";`,
    `Package._define("${meteorName}", __package__);`,
    `export * from "${mainModule}";`,
    ...(hasDefault ? [`export { default } from "${mainModule}";`] : []),
  ].join('\n');
}

export function getExportStr(meteorName, clientOrServer, jsExports, jsImports, isCommon, packageGetter) {
  const exportsSet = new Set(jsExports);
  const deps = new Set(Array.from(jsImports)
    .filter((dep) => dep.startsWith('@'))
    .map((dep) => nodeNameToMeteorName(dep)));

  const imported = new Set();
  const importedMap = new Map();
  deps.forEach((dep) => {
    const meteorPackage = packageGetter(dep);
    if (!meteorPackage) {
      throw new Error(`Missing dependency ${dep}`);
    }
    meteorPackage.getExportedVars(clientOrServer)
      .forEach((imp) => {
        if (exportsSet.has(imp)) {
          imported.add(imp);
          if (!importedMap.has(dep)) {
            importedMap.set(dep, new Set());
          }
          importedMap.get(dep).add(imp);
        }
      });
  });
  const localsToExport = jsExports.filter((exp) => !imported.has(exp));
  const packageDefinition = `Package["${meteorName}"] = { ${jsExports.join(', ')} };`;
  if (isCommon) {
    return [
      ...(jsExports.length ? ['const __package_globals__ = require("./__globals.js");'] : []),
      ...Array.from(importedMap.entries())
        .map(([dep, importSet]) => `const { ${Array.from(importSet).join(', ')} } =  require("${meteorNameToNodeName(dep)}");`),
      ...localsToExport.map((localExport) => `exports.${localExport} = __package_globals__.${localsToExport};`),
      packageDefinition,
    ].join('\n');
  }

  return [
    ...(jsExports.length ? ['import __package_globals__ from "./__globals.js"'] : []),
    ...Array.from(importedMap.entries())
      .map(([dep, importSet]) => `import { ${Array.from(importSet).join(', ')} } from "${meteorNameToNodeName(dep)}";`),
    localsToExport.length ? `const { ${localsToExport.join(', ')} }  = __package_globals__;` : '',
    `export { ${jsExports.join(', ')} };`,
    packageDefinition,
  ].join('\n');
}
