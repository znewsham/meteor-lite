import path from 'path';
import vm from 'vm';
import fs from 'fs-extra';
import fsPromises from 'fs/promises';
import { getPackageGlobals, replaceGlobalsInFile, globalStaticImports } from './helpers/globals.js';
import packageJsContext from './helpers/package-js-context.js';
import { getExportStr } from './helpers/content.js';

const excludes = new Set([
  'ecmascript',
  'modules',
  'isobuild:compiler-plugin',
  'ecmascript-runtime-client', // TODO
]);
const packageMap = new Map();

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
  #serverMainModule;
  #clientMainModule;

  #waitingWrite = [];

  constructor(folderName) {
    this.#folderName = folderName;
  }

  get folderName() {
    return this.#folderName;
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
      if (!opts?.testOnly && !archs?.length || archs.includes('client')) {
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
    if (!archs?.length || archs.includes('client')) {
      this.#clientJsImports.add(item);
    }
  }

  addMeteorDependencies(packages, archs, opts) {
    if (this.#nodeName !== '@meteor/meteor') {
      // TODO: hack - figure out how to deal with the global problem. In Meteor we need the global to be a package global, everywhere else we need it to be actually global (unless it's imported from meteor)
      this.#dependencies['@meteor/meteor'] = `file`;
      this.#allPackages.add('meteor');
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
      deps[`@meteor/${name}`] = version || `file`;
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
      // TODO
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
    return {
      name: this.#nodeName,
      version: this.#version,
      description: this.#description,
      dependencies: this.#dependencies,
      peerDependencies: this.#peerDependencies,
      exports: {
        '.': {
          node: './__server.js',
          default: './__client.js'
        },
        './*': './*'
      },
      exportedVars: {
        server: this.#serverJsExports,
        client: this.#clientJsExports
      },
      type: 'module',
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
      const globalsByFile = await getPackageGlobals(outputFolder);
      const allGlobals = new Set(Array.from(globalsByFile.values()).flatMap(v => Array.from(v)));
      const importedGlobals = this.getImportedGlobalsMap(allGlobals);
      const packageGlobals = Array.from(allGlobals).filter(global => !importedGlobals.has(global));
      
      
      globalsByFile.forEach((globals, file) => {
        replaceGlobalsInFile(outputParentFolder, globals, file, importedGlobals);
      });


      if (packageGlobals.length || this.#serverJsExports.length || this.#clientJsExports.length) {
        const exportNames = Array.from(new Set([
          ...this.#serverJsExports,
          ...this.#clientJsExports,
          ...packageGlobals
        ]));
        await fsPromises.writeFile(
          `${outputFolder}/__globals.js`,
          [
            'import module from "node:module";',
            'export default {',
            '  ' + exportNames.map(name => `${name}: undefined`).join(',\n') + ',',
            '  Npm: { require: module.createRequire(import.meta.url) },',
            '  module: { id: import.meta.url },',
            '  require: module.createRequire(import.meta.url)',
            '}'
          ].join('\n')
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
            ...Array.from(this.#serverJsImports).map(imp => `import "${imp}";`),
            ...!this.#serverMainModule && this.#serverJsExports.length ? [getExportStr('server', this.#serverJsExports, this.#serverJsImports, name => packageMap.get(name))] : [],
            ...this.#serverMainModule ? [`export * from "${this.#serverMainModule}";`] : []
          ].join('\n')
        ),
        fsPromises.writeFile(
          `${outputFolder}/__client.js`,
          [
            ...Array.from(this.#serverJsImports).map(imp => `import "${imp}";`),
            ...!this.#clientMainModule && this.#clientJsExports.length ? [getExportStr('client', this.#clientJsExports, this.#clientJsImports, name => packageMap.get(name))] : [],
            ...this.#clientMainModule ? [`export * from "${this.#clientMainModule}";`] : []
          ].join('\n')
        )
      ]);
    }
    catch (error) {
      console.log(this.#meteorName || this.#folderName, outputParentFolder);
      console.error(error);
    }
  }

  async loadFromMeteorPackage(pathToMeteorInstall) {
    try {
      const packageJsPath = this.findPackageJs(pathToMeteorInstall);
      const script = new vm.Script((await fsPromises.readFile(packageJsPath)).toString());
      const context = packageJsContext(this);
      script.runInNewContext(context);
      packageMap.set(this.#meteorName, this);

      // first make sure all impled or used packages are loaded
      this.#waitingWrite = (await Promise.all(Array.from(this.#allPackages).map(packageName => MeteorPackage.ensurePackage(
        packageName,
        pathToMeteorInstall,
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
      console.log(this.#meteorName || this.#folderName, outputParentFolder);
      console.error(error);
    }
  }
  
  async convert(outputParentFolder, pathToMeteorInstall) {
    await this.loadFromMeteorPackage(pathToMeteorInstall);
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

async function convertPackage(folderName, meteorInstall, outputParentFolder) {
  const meteorPackage = new MeteorPackage(folderName);
  await meteorPackage.convert(outputParentFolder, meteorInstall);
}

convertPackage(
  process.argv[2],
  process.argv[3].replace(/\/$/, ""),
  process.argv[4]
).catch(console.error);
