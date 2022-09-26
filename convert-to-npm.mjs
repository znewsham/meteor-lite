import path from 'path';
import vm from 'vm';
import fs from 'fs-extra';
import { walk } from 'estree-walker';
import { analyze as analyzeScope } from 'escope';
import { print } from 'recast';
import * as acorn from 'acorn';
import { readdir } from 'fs/promises';

const excludes = new Set([
  'ecmascript',
  'modules',
  'isobuild:compiler-plugin',
  'ecmascript-runtime-client', // TODO
]);

const excludeFindImports = new Set([
  'package.js',
  '__client.js',
  '__server.js',
  '__globals.js'
]);

const acornOptions = { ecmaVersion: 2020, sourceType: 'module', allowImportExportEverywhere: true, allowAwaitOutsideFunction: true };

const packageJsonMap = new Map();

function getOwnPropertyNames() {
  return Object.getOwnPropertyNames(this || global);
}

const globalStaticImports = new Map([['Meteor', '@meteor/meteor']]);
const globalBlacklist = new Set([
  'window',
  'document',
  'navigator',
  '__meteor_runtime_config__',
  '__meteor_bootstrap__',
  'Package', // meteor defines this on a package global called global, which is initted to the actual global. So Package is available everywhere 
  ...getOwnPropertyNames()
]);

globalBlacklist.delete('global'); // meteor does some fuckery here

const excludeFolders = new Set(['.npm', 'node_modules']);

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

function getGlobals(file, base, map) {
  const ast = acorn.parse(
    fs.readFileSync(file).toString(),
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
  ].filter(name => !globalBlacklist.has(name)));
  if (all.size) {
    map.set(file, all);
  } 
}

async function getPackageGlobals(folder) {
  const files = await getFileList(folder);
  const map = new Map();
  files.forEach(file => {
    try {
      return getGlobals(file, folder, map);
    }
    catch (e) {
      console.log("error with", file);
      throw e;
    }
  });
  return map;
}

async function ensurePackage(packageName, inputFolder, outputParentFolder) {
  if (packageJsonMap.get(packageName)) {
    return;
  }
  return convertPackage(path.join(inputFolder, packageName), outputParentFolder);
}

function getImportedGlobals(packageName, globals, packageJson) {
  const map = new Map();
  globals.forEach((global) => {
    if (globalStaticImports.has(global) && globalStaticImports.get(global) !== `@meteor/${packageName}`) {
      map.set(global, globalStaticImports.get(global));
    }
  })
  Object.keys(packageJson.dependencies)
  .filter(dep => dep.startsWith('@meteor/'))
  .forEach((dep) => {
    const packageName = dep.replace('@meteor/', '');
    const importedPackageJson = packageJsonMap.get(packageName);
    importedPackageJson.exportedVars.server.forEach((exp) => {
      if (globals.has(exp)) {
        map.set(exp, dep);
      }
    });
    importedPackageJson.exportedVars.client.forEach((exp) => {
      if (globals.has(exp)) {
        map.set(exp, dep);
      }
    });
  });
  return map;
}

function rewriteFileForPackageGlobals(contents, packageGlobalsSet) {
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

async function convertPackage(folder, outputParentFolder) {
  try {
    let packageJsPath = path.join(folder, 'package.js')
    if (!fs.existsSync(packageJsPath)) {
      folder = path.join(folder.split('/').slice(0, -1).join('/'), 'non-core', folder.split('/').slice(-1)[0]);
      packageJsPath = path.join(folder, 'package.js');
    }
    const script = new vm.Script(fs.readFileSync(packageJsPath).toString());
    const packageJson = {
      name: '',
      version: '',
      description: '',
      dependencies: {},
      peerDependencies: {},
      exports: {
        '.': {
          node: './__server.js',
          default: './__client.js'
        },
        './*': './*'
      },
      exportedVars: {
        client: [],
        server: []
      },
      type: 'module',
      implies: {
        server: [],
        client: []
      }
    };

    const clientJsImports = new Set();
    const clientJsExports = [];
    const allPackages = new Set();
    const serverJsImports = new Set();
    const serverJsExports = [];
    const impliedServerPackages = new Set();
    const impliedClientPackages = new Set();
    let serverMainModule;
    let clientMainModule;
    const context = {
      Cordova: {
        depends() {
          //noop
        }
      },
      Npm: {
        strip() {
          //noop
        },
        depends(deps) {
          Object.assign(packageJson.dependencies, deps);
        }
      },
      Package: {
        describe(description) {
          packageJson.name = `@meteor/${description.name || path.basename(folder).split('.')[0]}`;
          packageJson.description = description.summary;
          packageJson.version = description.version;
        },
        onTest() {
          // TODO
        },
        registerBuildPlugin() {
          // noop
        },
        onUse(cb) {
          cb({
            export(symbol, archOrArchs, maybeOpts) {
              // this is a manual process - will require going into the package.
              let archs = [];
              let opts;
              if (!maybeOpts && !Array.isArray(archOrArchs) && typeof archOrArchs === 'object') {
                if (archOrArchs) {
                  opts = archOrArchs;
                }
              }
              else {
                opts = maybeOpts;
                archs = archOrArchs && !Array.isArray(archOrArchs) ? [archOrArchs] : archOrArchs;
              }
              const symbols = !Array.isArray(symbol) ? [symbol] : symbol;
              symbols.forEach((symbol) => {
                if (!opts?.testOnly && !archs?.length || archs.includes('server')) {
                  serverJsExports.push(symbol);
                }
                if (!opts?.testOnly && !archs?.length || archs.includes('client')) {
                  clientJsExports.push(symbol);
                }
              });
            },
            use(packageOrPackages, archOrArchs, maybeOpts) {
              const packages = !Array.isArray(packageOrPackages) ? [packageOrPackages] : packageOrPackages;
              if (!folder.endsWith('/meteor')) {
                // TODO: hack - figure out how to deal with the global problem. In Meteor we need the global to be a package global, everywhere else we need it to be actually global (unless it's imported from meteor)
                packageJson.dependencies['@meteor/meteor'] = `file://${path.resolve(path.join(outputParentFolder, "meteor"))}`;
              }
              let archs = [];
              let opts;
              if (!maybeOpts && !Array.isArray(archOrArchs) && typeof archOrArchs === 'object') {
                if (archOrArchs) {
                  opts = archOrArchs;
                }
              }
              else {
                opts = maybeOpts;
                archs = archOrArchs && !Array.isArray(archOrArchs) ? [archOrArchs] : archOrArchs;
              }
              let deps = packageJson.dependencies;
              if (opts?.unordered) {
                // TODO: I think this is a problem with the local file install.
                deps = packageJson.peerDependencies;
              }
              packages.forEach((dep) => {
                const [name, version] = dep.split("@");
                if (excludes.has(name)) {
                  return;
                }
                allPackages.add(name);
                deps[`@meteor/${name}`] = version || `file://${path.resolve(path.join(outputParentFolder, name))}`;
                if (!opts?.unordered) {
                  if (!archs?.length || archs.includes('server')) {
                    serverJsImports.add(`@meteor/${name}`);
                  }
                  if (!archs?.length || archs.includes('client')) {
                    clientJsImports.add(`@meteor/${name}`);
                  }
                }
                // TODO: weak/other opts
              });
            },
            imply(packageOrPackages, archOrArchs) {
              const packages = !Array.isArray(packageOrPackages) ? [packageOrPackages] : packageOrPackages;
              let archs = archOrArchs && !Array.isArray(archOrArchs) ? [archOrArchs] : archOrArchs;

              packages.forEach((dep) => {
                const [name, version] = dep.split("@");
                if (excludes.has(name)) {
                  return;
                }
                // allPackages.add(name);
                // packageJson.dependencies[`@meteor/${name}`] = version || `file://${path.resolve(path.join(outputParentFolder, name))}`;
                /*if (!archs?.length || archs.includes('server')) {
                  serverJsImports.add(`@meteor/${name}`);
                  impliedServerPackages.add(name);
                }
                if (!archs?.length || archs.includes('client')) {
                  clientJsImports.add(`@meteor/${name}`);
                  impliedClientPackages.add(name);
                }*/
              });
            },
            addFiles(fileOrFiles, archOrArchs) {
              const files = !Array.isArray(fileOrFiles) ? [fileOrFiles] : fileOrFiles;
              let archs = archOrArchs && !Array.isArray(archOrArchs) ? [archOrArchs] : archOrArchs;
              files.forEach((file) => {
                if (!archs?.length || archs.includes('server')) {
                  serverJsImports.add(`./${file}`);
                }
                if (!archs?.length || archs.includes('client')) {
                  clientJsImports.add(`./${file}`);
                }
              })
            },
            mainModule(file, archOrArchs) {
              let archs = archOrArchs && !Array.isArray(archOrArchs) ? [archOrArchs] : archOrArchs;
              if (!archs?.length || archs.includes('server')) {
                serverMainModule =`./${file}`;
              }
              if (!archs?.length || archs.includes('client')) {
                clientMainModule = `./${file}`;
              }
            }
          });
        }
      }
    };
    script.runInNewContext(context);
    const packageName = packageJson.name.split("/")[1];
    packageJsonMap.set(packageName, packageJson);

    // first make sure all impled or used packages are loaded
    await Promise.all(Array.from(allPackages).map(packageName => ensurePackage(
      packageName,
      folder.split("/").slice(0, -1).join("/"),
      outputParentFolder
    )));

    // next, find all the direct dependencies and see what they imply. Then add those to our dependencies
    packageJson.implies.server = Array.from(impliedServerPackages);
    packageJson.implies.client = Array.from(impliedClientPackages);
    packageJson.exportedVars.server = serverJsExports;
    packageJson.exportedVars.client = clientJsExports;
    Object.keys(packageJson.dependencies).filter(dep => dep.startsWith('@meteor/'))
    .forEach((dep) => {
      const implies = packageJsonMap.get(dep.replace('@meteor/', '')).implies;
      context.Package.onUse((api) => {
        implies.server.forEach(name => api.use(name, 'server'));
        implies.client.forEach(name => api.use(name, 'client'));
      });
    });
    const outputFolder = `${outputParentFolder}/${path.basename(folder)}`;
    await fs.copy(folder, outputFolder, { filter(src, dest) { return !src.includes(".npm"); } });
    const globalsByFile = await getPackageGlobals(outputFolder);
    const allGlobals = new Set(Array.from(globalsByFile.values()).flatMap(v => Array.from(v)));
    const importedGlobals = getImportedGlobals(packageName, allGlobals, packageJson);
    
    const packageGlobals = Array.from(allGlobals).filter(global => !importedGlobals.has(global));
    globalsByFile.forEach((globals, file) => {
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
        const fileContents = fs.readFileSync(file).toString();
        const importStr = Array.from(imports.entries()).map(([from, imports]) => {
          if (from === '__globals.js') {
            // get the relative path of __globals.js
            const relative = file.replace(outputParentFolder.replace("./", ""), "").split('/').slice(2).map(a => '..').join('/');
            from = `./${relative}${relative && '/'}__globals.js`;
            return `import __package_globals__ from "${from}";`;
          }
          return `import { ${Array.from(imports).join(', ')} } from "${from}";`;
        }).join('\n');
        try {
          fs.writeFileSync(file, `${importStr}\n${rewriteFileForPackageGlobals(fileContents, imports.get('__globals.js'))}`);
        }
        catch (e) {
          console.log('error with', file);
          throw e;
        }
      }
    });
    if (packageGlobals.length || serverJsExports.length || clientJsExports.length) {
      const exportNames = Array.from(new Set([
        ...serverJsExports,
        ...clientJsExports,
        ...packageGlobals
      ]));
      fs.writeFileSync(`${outputFolder}/__globals.js`, [
        'import module from "node:module";',

        `export default {\n${exportNames.map(name => `${name}: undefined`).join(',\n')},\nNpm: { require: module.createRequire(import.meta.url) },\nmodule: { id: import.meta.url },\nrequire: module.createRequire(import.meta.url)\n};`
      ].join('\n'));
    }

    const getExportStr = (clientOrServer, jsExports, jsImports) => {
      const exportsSet = new Set(jsExports);
      const deps = new Set(Array.from(jsImports).filter(dep => dep.startsWith('@meteor/')).map(dep => dep.replace('@meteor/', '')));
      const imported = new Set();
      const importedMap = new Map();
      deps.forEach((dep) => {
        const json = packageJsonMap.get(dep);
        json.exportedVars[clientOrServer].forEach((imp) => {
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
        `import __package_globals__ from "./__globals.js"`,
        ...Array.from(importedMap.entries()).map(([dep, importSet]) => `import { ${Array.from(importSet).join(', ')} } from "@meteor/${dep}";`),
        localsToExport.length ? `const { ${localsToExport.join(', ')} }  = __package_globals__;` : '',
        `export { ${jsExports.join(', ')} };`
      ].join('\n');
    };
    fs.writeFileSync(`${outputFolder}/package.json`, JSON.stringify(packageJson, null, 2));
    fs.writeFileSync(`${outputFolder}/__server.js`, [
      ...Array.from(serverJsImports).map(imp => `import "${imp}";`),
      ...!serverMainModule && serverJsExports.length ? [getExportStr('server', serverJsExports, serverJsImports)] : [],
      ...serverMainModule ? [`export * from "${serverMainModule}";`] : []
    ].join('\n'));
    fs.writeFileSync(`${outputFolder}/__client.js`, [
      ...Array.from(clientJsImports).map(imp => `import "${imp}";`),
      ...!clientMainModule && clientJsExports.length ? [getExportStr('client', clientJsExports, clientJsImports)] : [],
      ...clientMainModule ? [`export * from "${clientMainModule}";`] : []
    ].join('\n'));
  }
  catch (error) {
    console.log(folder, outputParentFolder);
    console.error(error);
  }
}

convertPackage(
  process.argv[2].replace(/\/$/, ""),
  process.argv[3]
).catch(console.error);
