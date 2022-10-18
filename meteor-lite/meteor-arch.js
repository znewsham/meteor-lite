import path from 'path';
import { getImportTreeForPackageAndClean } from './helpers/globals.js';

export default class MeteorArch {
  #archName;

  #parentArch;

  #childArchs = new Set();

  #exports = [];

  #imports = new Set();

  #impliedPackages = new Set();

  #mainModule;

  #assets = [];

  #modified = false;

  constructor(archName, parentArch) {
    this.#archName = archName;
    this.#parentArch = parentArch;
    if (parentArch) {
      parentArch.#childArchs.add(this);
    }
  }

  addExport(symbol) {
    this.#exports.push(symbol);
    this.#modified = true;
  }

  addAsset(file) {
    this.#assets.push(file);
    this.#modified = true;
  }

  addImport(item) {
    this.#imports.add(item);
    this.#modified = true;
  }

  addImpliedPackage(nodeName) {
    this.#imports.add(nodeName);
    this.#impliedPackages.add(nodeName);
    this.#modified = true;
  }

  setMainModule(filePath) {
    this.#mainModule = filePath;
    this.#modified = true;
  }

  getImports(justOwn = false) {
    if (justOwn) {
      return this.#imports;
    }
    return new Set([...this.#parentArch?.getImports() || [], ...this.#imports]);
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
    return [...this.#parentArch?.getExports() || [], ...this.#exports];
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
    outputFolder,
    archsForFiles,
    isCommon,
    exportedMap,
  ) {
    return getImportTreeForPackageAndClean(
      outputFolder,
      [
        ...(this.getMainModule() ? [path.join(outputFolder, this.getMainModule())] : []),
        ...Array.from(this.getImports())
          .filter((file) => file.startsWith('.'))
          .filter((file) => file.endsWith('.js'))
          .map((file) => path.join(outputFolder, file)),
      ],
      this.#archName,
      archsForFiles,
      isCommon,
      exportedMap,
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
