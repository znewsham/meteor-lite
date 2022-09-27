export function getExportStr(clientOrServer, jsExports, jsImports, packageGetter) {
  const exportsSet = new Set(jsExports);
  const deps = new Set(Array.from(jsImports)
  .filter(dep => dep.startsWith('@meteor/'))
  .map(dep => dep.replace('@meteor/', '')));

  const imported = new Set();
  const importedMap = new Map();
  deps.forEach((dep) => {
    const meteorPackage = packageGetter(dep);
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
  const localsToExport = jsExports.filter(exp => !imported.has(exp));
  return [
    'import __package_globals__ from "./__globals.js"',
    ...Array.from(importedMap.entries())
    .map(([dep, importSet]) => `import { ${Array.from(importSet).join(', ')} } from "@meteor/${dep}";`),
    localsToExport.length ? `const { ${localsToExport.join(', ')} }  = __package_globals__;` : '',
    `export { ${jsExports.join(', ')} };`
  ].join('\n');
};
