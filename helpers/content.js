export function getExportStr(meteorName, clientOrServer, jsExports, jsImports, isCommon, packageGetter) {
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
  const packageDefinition = `Package["${meteorName}"] = { ${jsExports.join(", ")} };`;
  if (isCommon) {
    return [
      ...(jsExports.length ? ['const __package_globals__ = require("./__globals.js");'] : []),
      ...Array.from(importedMap.entries())
      .map(([dep, importSet]) => `const { ${Array.from(importSet).join(', ')} } =  require("@meteor/${dep}");`),
      ...localsToExport.map(localExport => `exports.${localExport} = __package_globals__.${localsToExport};`),
      packageDefinition
    ].join('\n');
  }
  else {
    return [
      ...(jsExports.length ? ['import __package_globals__ from "./__globals.js"'] : []),
      ...Array.from(importedMap.entries())
      .map(([dep, importSet]) => `import { ${Array.from(importSet).join(', ')} } from "@meteor/${dep}";`),
      localsToExport.length ? `const { ${localsToExport.join(', ')} }  = __package_globals__;` : '',
      `export { ${jsExports.join(', ')} };`,
      packageDefinition
    ].join('\n');
  }
};
