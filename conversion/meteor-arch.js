import path from 'path';
import { getImportTreeForPackageAndClean } from './globals.js';

export default class MeteorArch {
  #archName;

  #parentArch;

  #childArchs = new Set();

  #exports = [];

  #imports = new Map();

  #impliedPackages = new Set();

  #preloadPackages = new Set();

  #unorderedPackages = new Set();

  #mainModule;

  #assets = [];

  #modified = false;

  // just to assist in debugging
  #meteorPackageName;

  constructor(archName, parentArch, meteorPackageName) {
    this.#archName = archName;
    this.#parentArch = parentArch;
    this.#meteorPackageName = meteorPackageName;
    if (parentArch) {
      parentArch.#childArchs.add(this);
    }
  }

  getChildArchs() {
    return this.#childArchs;
  }

  getAllChildArchs() {
    return new Set(Array.from(this.#childArchs).flatMap((childArch) => [
      childArch,
      ...childArch.getAllChildArchs(),
    ]));
  }

  #setModified() {
    this.#modified = true;
  }

  addExport(symbol) {
    this.#exports.push(symbol);
    this.#setModified();
  }

  addAsset(file) {
    this.#assets.push(file);
    this.#setModified();
  }

  addImport(item, importOrder) {
    this.#imports.set(item, importOrder);
    this.#setModified();
  }

  addPreloadPackage(nodeName) {
    this.#preloadPackages.add(nodeName);
    this.#setModified();
  }

  addUnorderedPackage(nodeName) {
    this.#unorderedPackages.add(nodeName);
    this.#setModified();
  }

  addImpliedPackage(meteorName) {
    this.#impliedPackages.add(meteorName);
    this.#setModified();
  }

  setMainModule(filePath) {
    this.#mainModule = filePath;
    this.#setModified();
  }

  getPreloadPackages(justOwn = false) {
    if (justOwn) {
      return this.#preloadPackages;
    }
    return new Set([...this.#parentArch?.getPreloadPackages() || [], ...this.#preloadPackages]);
  }

  #getImportsEntries() {
    return [
      ...Array.from(this.#imports.entries()),
      ...(this.#parentArch ? Array.from(this.#parentArch.#getImportsEntries()) : []),
    ];
  }

  getImports(justOwn = false) {
    if (justOwn) {
      return new Set(this.#imports.keys());
    }
    const all = this.#getImportsEntries();

    all.sort((a, b) => a[1] - b[1]);

    return new Set(all.map(([imp]) => imp));
  }

  getMainModule(justOwn = false) {
    if (justOwn) {
      return this.#mainModule;
    }
    return this.#mainModule || this.#parentArch?.getMainModule();
  }

  getExports(justOwn = false) {
    if (justOwn) {
      return this.#exports;
    }
    return Array.from(new Set([...this.#parentArch?.getExports() || [], ...this.#exports]));
  }

  getAssets(justOwn = false) {
    if (justOwn) {
      return this.#assets;
    }
    return [...this.#parentArch?.getAssets() || [], ...this.#assets];
  }

  getImpliedPackages(justOwn = false) {
    if (justOwn) {
      return this.#impliedPackages;
    }
    return new Set([...this.#parentArch?.getImpliedPackages() || [], ...this.#impliedPackages]);
  }

  get archName() {
    return this.#archName;
  }

  get parentArch() {
    return this.#parentArch;
  }

  async getImportTreeForPackageAndClean(
    baseFolder,
    archsForFiles,
    isCommon,
    exportedMap,
    astForFiles,
  ) {
    return getImportTreeForPackageAndClean(
      baseFolder,
      [
        ...(this.getMainModule() ? [path.join(baseFolder, this.getMainModule())] : []),
        ...Array.from(this.getImports())
          .filter((file) => file.startsWith('.'))
          .filter((file) => file.endsWith('.js'))
          .map((file) => path.join(baseFolder, file)),
      ],
      this.#archName,
      archsForFiles,
      isCommon,
      exportedMap,
      astForFiles,
    );
  }

  hasChildArchs() {
    return this.#childArchs.size !== 0;
  }

  isNoop(justOwn = true) {
    if (!justOwn) {
      return !this.#modified && this.parentArch?.isNoop();
    }
    return !this.#modified;
  }

  getExportArchName() {
    if (this.#archName === 'server') {
      return 'node';
    }
    return this.#archName;
  }

  getActiveArch() {
    if (!this.isNoop() || !this.#parentArch) {
      return this;
    }
    return this.#parentArch.getActiveArch();
  }
}
