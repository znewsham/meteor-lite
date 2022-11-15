import module from 'module';
import { getCorePackageVersion } from './ensure-local-package';

const aRequire = module.createRequire(import.meta.url);

async function callbackWrapper(meteorPackage, cb, isTest = false) {
  const useCalls = [];
  const implyCalls = [];
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
      useCalls.push({
        packages,
        archs,
        opts,
      });
    },
    imply(packageOrPackages, archOrArchs) {
      const packages = !Array.isArray(packageOrPackages) ? [packageOrPackages] : packageOrPackages;
      const archs = archOrArchs && !Array.isArray(archOrArchs) ? [archOrArchs] : archOrArchs;
      implyCalls.push({ packages, archs });
    },
    addFiles(fileOrFiles, archOrArchs) {
      const files = !Array.isArray(fileOrFiles) ? [fileOrFiles] : fileOrFiles;
      const archs = archOrArchs && !Array.isArray(archOrArchs) ? [archOrArchs] : archOrArchs;
      files.forEach((file) => {
        meteorPackage.addImport(`./${file}`, archs, { testOnly: isTest });
      });
    },
    mainModule(file, archOrArchs, opts) {
      const archs = archOrArchs && !Array.isArray(archOrArchs) ? [archOrArchs] : archOrArchs;
      meteorPackage.setMainModule(file, archs, { ...opts, testOnly: isTest });
    },
  });

  /*if (meteorVersion) {
    await Promise.all([...useCalls, ...implyCalls].map(async (useOrImplyCall) => {
      useOrImplyCall.packages = await Promise.all(useOrImplyCall.packages.map(async (packageAndMaybeVersion) => {
        if (packageAndMaybeVersion.includes('@')) {
          return packageAndMaybeVersion;
        }
        const version = await getCorePackageVersion({ meteorVersion, meteorInstall, name: packageAndMaybeVersion });
        if (!version) {
          return packageAndMaybeVersion;
        }
        return `${packageAndMaybeVersion}@${version}`;
      }));
    }));
  }*/
  useCalls.forEach(({ packages, archs, opts }) => {
    meteorPackage.addMeteorDependencies(packages, archs, opts);
  });
  implyCalls.forEach(({ packages, archs }) => {
    meteorPackage.addImplies(packages, archs);
  });
}
export default function packageJsContext(meteorPackage) {
  const ret = {
    process: globalThis.process,
    global: globalThis,
    onUsePromise: undefined,
    onTestPromise: undefined,
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

      // because packages like qualia:docs and qultra:lucky-tests use functions like autoLoad (which are declared after package.onUse)
      // we need to ensure the entire file has parsed, before we actually call the callbacks here.
      // Presumably this works in meteor due to fiber magic
      onTest(cb) {
        ret.onTestPromise = Promise.resolve().then(() => callbackWrapper(meteorPackage, cb, true));
      },
      onUse(cb) {
        ret.onUsePromise = Promise.resolve().then(() => callbackWrapper(meteorPackage, cb, false));
      },
    },
  };

  return ret;
}
