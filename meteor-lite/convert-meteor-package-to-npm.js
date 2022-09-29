import path from 'path';
import vm from 'vm';
import fs from 'fs-extra';
import fsPromises from 'fs/promises';
import { getPackageGlobals, replaceGlobalsInFile, globalStaticImports } from './helpers/globals.js';
import packageJsContext from './helpers/package-js-context.js';
import { getExportStr } from './helpers/content.js';

const commonJS = new Set([
  'jquery',
  'underscore'
]);

const excludes = new Set([
  'ecmascript',
  'typescript',
  'modules',
  'isobuild:compiler-plugin',
  'isobuild:dynamic-import', // TODO?
  'ecmascript-runtime-client', // TODO?
  'isobuild:minifier-plugin',
  'standard-minifier-css',
  'standard-minifier-js',
  'hot-module-replacement' // this has a strong dependency on modules
]);
export const packageMap = new Map();

function getImportStr(importsSet, isCommon) {
  if (isCommon) {
    return Array.from(importsSet).map(imp => `require("${imp}");`).join('\n');
  }
  else {
    return Array.from(importsSet).map(imp => `import "${imp}";`).join('\n');
  }
}

const meteorVersionPlaceholderSymbol = Symbol('meteor-version-placeholder');

class MeteorPackage {
  #folderName;
  #parentFolderPath;
  #meteorName;
  #nodeName;
  #version;
  #description;
  #dependencies = {};
  #peerDependencies = {};
  #serverJsExports = [];
  #clientJsExports = [];
  #clientJsImports = new Set();
  #serverJsImports = new Set();
  #impliedClientPackages = new Set();
  #impliedServerPackages = new Set();
  #allPackages = new Set();
  #imports = {};
  #serverMainModule;
  #clientMainModule;
  #clientAssets = new Array();
  #serverAssets = new Array();

  #waitingWrite = [];

  constructor(folderName) {
    this.#folderName = folderName;
  }

  get folderName() {
    return this.#folderName;
  }

  isCommon() {
    return commonJS.has(this.#meteorName);
  }

  setBasic({ name, description, version }) {
    this.#meteorName = name;
    this.#nodeName = `@meteor/${name}`;
    this.#description = description;
    this.#version = version;
  }

  addExports(symbols, archs, opts) {
    symbols.forEach((symbol) => {
      if (!opts?.testOnly && !archs?.length || archs.includes('server')) {
        this.#serverJsExports.push(symbol);
      }
      if (!opts?.testOnly && !archs?.length || archs.includes('client') || archs.includes('web') || archs.includes('web.browser')) {
        this.#clientJsExports.push(symbol);
      }
    });
  }

  addNpmDeps(deps) {
    Object.assign(this.#dependencies, deps);
  }

  addImport(item, archs) {
    if (!archs?.length || archs.includes('server')) {
      this.#serverJsImports.add(item);
    }
    if (!archs?.length || archs.includes('client') || archs.includes('web') || archs.includes('web.browser')) {
      this.#clientJsImports.add(item);
    }
  }

  addAssets(files, archs) {
    files.forEach((file) => {
      if (!archs?.length || archs.includes("client") || archs.includes('web') || archs.includes('web.browser')) {
        this.#clientAssets.push(file);
      }
      if (!archs?.length || archs.includes("server")) {
        this.#serverAssets.push(file);
      }
    });
  }

  addMeteorDependencies(packages, archs, opts) {
    if (this.#nodeName !== '@meteor/meteor') {
      // TODO: hack - figure out how to deal with the global problem. In Meteor we need the global to be a package global, everywhere else we need it to be actually global (unless it's imported from meteor)
      this.#dependencies['@meteor/meteor'] = meteorVersionPlaceholderSymbol;
      this.#allPackages.add('meteor');

      // why does this condition need to be here and not above? It seems like all packages (e.g., underscore) need the `allPackages` and `dependencies` set,
      // but common mustn't import.
      if (!this.isCommon()) {
        this.addImport(`@meteor/meteor`, ['client', 'server']);
      }
    }
    let deps = this.#dependencies;
    if (opts?.unordered) {
      // TODO: I think this is a problem with the local file install.
      deps = this.#peerDependencies;
    }
    packages.forEach((dep) => {
      const [name, version] = dep.split("@");
      if (excludes.has(name)) {
        return;
      }
      this.#allPackages.add(name);
      // we should probably NEVER use version, since we can't do resolution the way we want (at least until all versions are published to npm)
      deps[`@meteor/${name}`] = meteorVersionPlaceholderSymbol;
      if (!opts?.unordered) {
        this.addImport(`@meteor/${name}`, archs);
      }
      // TODO: weak/other opts
    });
  }

  addImplies(packages, archs) {
    packages.forEach((dep) => {
      const [name, version] = dep.split("@");
      if (excludes.has(name)) {
        return;
      }
      this.#allPackages.add(name);

      // we should probably NEVER use version, since we can't do resolution the way we want (at least until all versions are published to npm)
      this.#dependencies[`@meteor/${name}`] = meteorVersionPlaceholderSymbol;
      if (!archs?.length || archs.includes('server')) {
        this.#serverJsImports.add(`@meteor/${name}`);
        this.#impliedServerPackages.add(`@meteor/${name}`);
      }
      if (!archs?.length || archs.includes('client')) {
        this.#clientJsImports.add(`@meteor/${name}`);
        this.#impliedClientPackages.add(`@meteor/${name}`);
      }
    });
  }

  setMainModule(file, archs) {
    if (!archs?.length || archs.includes('server')) {
      this.#serverMainModule =`./${file}`;
    }
    if (!archs?.length || archs.includes('client')) {
      this.#clientMainModule = `./${file}`;
    }
  }

  toJSON() {
    const newDependencies = Object.fromEntries(Object.entries(this.#dependencies).map(([name, version]) => {
      if (version === meteorVersionPlaceholderSymbol) {
        return [name, packageMap.get(name.replace("@meteor/", "")).#version];
      }
      return [name, version];
    }));
    return {
      name: this.#nodeName,
      version: this.#version,
      description: this.#description,
      dependencies: newDependencies,
      peerDependencies: this.#peerDependencies,
      exports: {
        '.': {
          node: {
            import: './__server.js',
            require: !commonJS.has(this.#meteorName) ? './__server.cjs' : undefined
          },
          default: {
            import: './__client.js',
            require: !commonJS.has(this.#meteorName) ? './__client.cjs' : undefined
          }
        },
        './*': './*'
      },
      imports: this.#imports,
      exportedVars: {
        server: this.#serverJsExports,
        client: this.#clientJsExports
      },
      assets: {
        client: this.#clientAssets,
        server: this.#serverAssets
      },
      type: commonJS.has(this.#meteorName) ? 'commonjs' : 'module',
      implies: {
        client: Array.from(this.#impliedClientPackages),
        server: Array.from(this.#impliedServerPackages)
      }
    };
  }


  getImportedGlobalsMap(globals) {
    const map = new Map();
    globals.forEach((global) => {
      if (globalStaticImports.has(global) && globalStaticImports.get(global) !== this.#nodeName) {
        map.set(global, globalStaticImports.get(global));
      }
    })
    Object.keys(this.#dependencies)
    .filter(dep => dep.startsWith('@meteor/'))
    .forEach((dep) => {
      const packageName = dep.replace('@meteor/', '');
      packageMap.get(packageName)
      .getExportedVars()
      .forEach((exp) => {
        if (globals.has(exp)) {
          map.set(exp, dep);
        }
      });
    });
    return map;
  }
  
  getImplies(clientOrServer) {
    if (!clientOrServer) {
      return Array.from(new Set([
        ...this.#impliedServerPackages,
        ...this.#impliedClientPackages,
      ]))
    }
    return clientOrServer === 'server' ? this.#impliedServerPackages : this.#impliedClientPackages;
  }

  getExportedVars(clientOrServer) {
    if (!clientOrServer) {
      return Array.from(new Set([
        ...this.#serverJsExports,
        ...this.#clientJsExports,
      ]))
    }
    return clientOrServer === 'server' ? this.#serverJsExports : this.#clientJsExports;
  }

  async writeToNpmModule(outputParentFolder) {
    try {
      await Promise.all(this.#waitingWrite.map(waiting => waiting.writeToNpmModule(outputParentFolder)));
      const outputFolder = `${outputParentFolder}/${this.#meteorName}`;
      await fs.copy(
        path.join(this.#parentFolderPath, this.#folderName),
        outputFolder,
        { filter(src) { return !src.includes(".npm"); } }
      );
      const globalsByFile = await getPackageGlobals(outputFolder, commonJS.has(this.#meteorName));
      const allGlobals = new Set(Array.from(globalsByFile.values()).flatMap(v => Array.from(v)));
      const importedGlobals = this.getImportedGlobalsMap(allGlobals);
      const packageGlobals = Array.from(allGlobals).filter(global => !importedGlobals.has(global));
      
      
      globalsByFile.forEach((globals, file) => {
        replaceGlobalsInFile(outputParentFolder, globals, file, importedGlobals, this.isCommon(), name => packageMap.get(name));
      });


      if (packageGlobals.length || this.#serverJsExports.length || this.#clientJsExports.length) {
        const exportNamesSet = new Set([
          ...this.#serverJsExports,
          ...this.#clientJsExports,
          ...packageGlobals
        ]);
        
        const hasRequire = exportNamesSet.has('require');
        const hasExports = exportNamesSet.has('exports');
        const hasModule = exportNamesSet.has('module');
        const hasNpm = exportNamesSet.has('Npm');
        const hasAssets = exportNamesSet.has('Assets');
        exportNamesSet.delete('require');
        exportNamesSet.delete('module');
        exportNamesSet.delete('Npm');
        exportNamesSet.delete('Assets');
        if (hasAssets) {
          this.#imports['#assets'] = {
            node: './__server_assets.js',
            default: './__client_assets.js'
          };
          await Promise.all([
            fs.writeFile(
              `${outputFolder}/__client_assets.js`,
              'export default {}'
            ),
            fs.writeFile(
              `${outputFolder}/__server_assets.js`,
              [
                'import fs from \'fs\';',
                'import fsPromises from \'fs/promises\';',
                'import Fiber from \'fibers\';',
                'import path from \'path\';',
                'const basePath = path.dirname(import.meta.url).replace(\'file:\', \'\')',
                'export default {',
                '  getText(file) {',
                '    return Fiber.current ? Promise.await(fsPromises.readFile(path.join(basePath, file))).toString() : fs.readFileSync(path.join(basePath, file)).toString();',
                '  }',
                '};'
              ].join('\n')
            )
          ])
        }
        if ((hasRequire || hasExports) && this.#serverMainModule) {
          console.warn(`esm module ${this.#meteorName} using exports or require, this probably wont work`);
        }
        if ((hasModule || hasNpm || hasRequire) && !this.isCommon()) {
          this.#imports['#module'] = {
            node: './__server_module.js',
            default: './__client_module.js'
          };
          await fsPromises.writeFile(
            `${outputFolder}/__client_module.js`,
            `export default {
              createRequire() {return require}
            };
            `
          )
          await fsPromises.writeFile(
            `${outputFolder}/__server_module.js`,
            "export { default } from 'node:module'"
          )
        }
        if (this.isCommon()) {
          await fsPromises.writeFile(
            `${outputFolder}/__globals.js`,
            // TODO support assets for cjs
            Array.from(exportNamesSet).map(name => `module.exports.${name} = undefined;`).join('\n'),
          );
        }
        else {
          await fsPromises.writeFile(
            `${outputFolder}/__globals.js`,
            [
              ...(hasModule || hasNpm || hasRequire ? ['import module from "#module";'] : []),
              ...hasAssets ? ['import Assets from \'#assets\''] : [],
              'export default {',
              ...(exportNamesSet.size ? ['  ' + Array.from(exportNamesSet).map(name => `${name}: undefined`).join(',\n  ') + ','] : []),
              ...(hasNpm ? ['  Npm: { require: module.createRequire(import.meta.url) },'] : []),
              ...(hasModule ? ['  module: { id: import.meta.url },'] : []),
              ...(hasRequire ? ['  require: module.createRequire(import.meta.url),'] : []),
              ...(hasAssets ? ['Assets'] : []),
              '}'
            ].join('\n')
          );
        }
      }
      if (!this.isCommon()) {
        fsPromises.writeFile(
          `${outputFolder}/__server.cjs`, 
          `module.exports = Package["${this.#meteorName}"];`
        );
        fsPromises.writeFile(
          `${outputFolder}/__client.cjs`, 
          `module.exports = Package["${this.#meteorName}"];`
        );
      }
      await Promise.all([
        fsPromises.writeFile(
          `${outputFolder}/package.json`,
          JSON.stringify(this.toJSON(), null, 2)
        ),
        fsPromises.writeFile(
          `${outputFolder}/__server.js`, 
          [
            getImportStr(this.#serverJsImports, commonJS.has(this.#meteorName)),
            ...!this.#serverMainModule ? [getExportStr(this.#meteorName, 'server', this.#serverJsExports, this.#serverJsImports, commonJS.has(this.#meteorName), name => packageMap.get(name))] : [],
            ...(this.#serverMainModule ? [
              `import * as __package__ from "${this.#serverMainModule}";`,
              `Package._define("${this.#meteorName}", __package__);`,
              `export * from "${this.#serverMainModule}";`
            ] : [])
          ].join('\n')
        ),
        fsPromises.writeFile(
          `${outputFolder}/__client.js`,
          [
            getImportStr(this.#clientJsImports, commonJS.has(this.#meteorName)),
            ...!this.#clientMainModule ? [getExportStr(this.#meteorName, 'client', this.#clientJsExports, this.#clientJsImports, commonJS.has(this.#meteorName), name => packageMap.get(name))] : [],
            ...(this.#clientMainModule ? [
              `import * as __package__ from "${this.#clientMainModule}";`,
              `Package._define("${this.#meteorName}", __package__);`,
              `export * from "${this.#clientMainModule}";`
            ] : [])
          ].join('\n')
        )
      ]);
    }
    catch (error) {
      console.log(this.#meteorName || this.#folderName, outputParentFolder);
      console.error(error);
      throw error;
    }
  }

  async loadFromMeteorPackage(pathToMeteorInstall, ...otherPaths) {
    try {
      const packageJsPath = this.findPackageJs(pathToMeteorInstall, ...otherPaths);
      const script = new vm.Script((await fsPromises.readFile(packageJsPath)).toString());
      const context = packageJsContext(this);
      script.runInNewContext(context);
      packageMap.set(this.#meteorName, this);

      // first make sure all impled or used packages are loaded
      this.#waitingWrite = (await Promise.all(Array.from(this.#allPackages).map(packageName => MeteorPackage.ensurePackage(
        packageName,
        pathToMeteorInstall,
        ...otherPaths
      )))).filter(Boolean);

      // next, find all the direct dependencies and see what they imply. Then add those to our dependencies
      Object.keys(this.#dependencies).filter(dep => dep.startsWith('@meteor/'))
      .forEach((dep) => {
        const importedPackage = packageMap.get(dep.replace('@meteor/', ''));
        importedPackage.getImplies('client').forEach(name => this.addImport(name, 'client'));
        importedPackage.getImplies('server').forEach(name => this.addImport(name, 'server'));
      });
    }
    catch (error) {
      console.log(this.#meteorName || this.#folderName);
      console.error(error);
      throw error;
    }
  }
  
  async convert(outputParentFolder, pathToMeteorInstall, ...packagesPaths) {
    await this.loadFromMeteorPackage(pathToMeteorInstall, ...packagesPaths);
    await this.writeToNpmModule(outputParentFolder);
  }

  findPackageJs(pathToMeteorInstall, ...packagesPaths) {
    const folders = MeteorPackage.foldersToSearch(pathToMeteorInstall, ...packagesPaths);
    const folder = folders.find((folder) => {
      const packagePath = path.join(folder, this.#folderName, 'package.js');
      if (fs.existsSync(packagePath)) {
        this.#parentFolderPath = folder;
        return true;
      }
    });
    if (!folder) {
      throw new Error(`package ${this.#folderName} not found`);
    }
    return path.join(folder, this.#folderName, 'package.js');
  }

  static foldersToSearch(pathToMeteorInstall, ...packagesPaths) {
    return [
      pathToMeteorInstall,
      path.join(pathToMeteorInstall, 'non-core'),
      ...packagesPaths
    ];
  }

  static async ensurePackage(name, pathToMeteorInstall, ...packagesPaths) {
    // TODO: search for packages with this name rather than assuming name === folderName
    if (!packageMap.has(name)) {
      const meteorPackage = new MeteorPackage(name);
      packageMap.set(name, meteorPackage);
      await meteorPackage.loadFromMeteorPackage(pathToMeteorInstall, ...packagesPaths);
      return meteorPackage;
    }
  }
}

// TODO: we're overloading name here.
export async function convertPackage(folderName, outputParentFolder, meteorInstall, ...otherPackageFolders) {
  outputParentFolder = path.resolve(outputParentFolder);
  if (excludes.has(folderName) || packageMap.has(folderName)) {
    return;
  }
  const meteorPackage = new MeteorPackage(folderName);
  packageMap.set(folderName, meteorPackage);
  await meteorPackage.convert(outputParentFolder, meteorInstall, ...otherPackageFolders);
}

/*convertPackage(
  process.argv[2],
  process.argv[3],
  ...process.argv.slice(4).map(v => v.replace(/\/$/, ""))
).catch(console.error);
*/
