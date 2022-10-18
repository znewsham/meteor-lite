import module from 'module';

const aRequire = module.createRequire(import.meta.url);


function callbackWrapper(meteorPackage, cb, isTest = false) {
  cb({
    versionsFrom() {

    },
    export(symbol, archOrArchs, maybeOpts) {
      if (isTest) {
        return; // TODO?
      }
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
      meteorPackage.addExports(symbols, archs, opts);
    },
    addAssets(fileOrFiles, archOrArchs) {
      const files = !Array.isArray(fileOrFiles) ? [fileOrFiles] : fileOrFiles;
      const archs = archOrArchs && !Array.isArray(archOrArchs) ? [archOrArchs] : archOrArchs;
      meteorPackage.addAssets(files, archs);
    },
    use(packageOrPackages, archOrArchs, maybeOpts) {
      const packages = !Array.isArray(packageOrPackages) ? [packageOrPackages] : packageOrPackages;
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
      if (!opts) {
        opts = {};
      }
      if (isTest) {
        opts.testOnly = true;
      }
      meteorPackage.addMeteorDependencies(packages, archs, opts);
    },
    imply(packageOrPackages, archOrArchs) {
      const packages = !Array.isArray(packageOrPackages) ? [packageOrPackages] : packageOrPackages;
      const archs = archOrArchs && !Array.isArray(archOrArchs) ? [archOrArchs] : archOrArchs;
      meteorPackage.addImplies(packages, archs);
    },
    addFiles(fileOrFiles, archOrArchs) {
      const files = !Array.isArray(fileOrFiles) ? [fileOrFiles] : fileOrFiles;
      const archs = archOrArchs && !Array.isArray(archOrArchs) ? [archOrArchs] : archOrArchs;
      files.forEach((file) => {
        meteorPackage.addImport(`./${file}`, archs, { testOnly: isTest });
      });
    },
    mainModule(file, archOrArchs) {
      const archs = archOrArchs && !Array.isArray(archOrArchs) ? [archOrArchs] : archOrArchs;
      meteorPackage.setMainModule(file, archs, { testOnly: isTest });
    },
  });
}
export default function packageJsContext(meteorPackage) {
  return {
    process: globalThis.process,
    global: globalThis,
    Cordova: {
      depends() {
        // noop
      },
    },
    Npm: {
      strip() {
        // noop
      },
      depends(deps) {
        meteorPackage.addNpmDeps(deps);
      },
      require(moduleName) {
        return aRequire(moduleName);
      },
    },
    Package: {
      describe(description) {
        meteorPackage.setBasic({
          name: description.name || meteorPackage.folderName,
          description: description.summary,
          version: description.version,
          testOnly: description.testOnly,
          prodOnly: description.prodOnly,
          devOnly: description.devOnly,
        });
      },
      registerBuildPlugin() {
        // noop
      },
      onTest(cb) {
        callbackWrapper(meteorPackage, cb, true);
      },
      onUse(cb) {
        callbackWrapper(meteorPackage, cb, false);
      },
    },
  };
}
