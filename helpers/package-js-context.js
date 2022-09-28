import path from 'path';

export default function packageJsContext(meteorPackage) {
  return {
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
        meteorPackage.addNpmDeps(deps);
      }
    },
    Package: {
      describe(description) {
        meteorPackage.setBasic({
          name: description.name || meteorPackage.folderName,
          description: description.summary,
          version: description.version
        });
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
            meteorPackage.addExports(symbols, archs, opts);
          },
          addAssets(fileOrFiles, archOrArchs) {
            const files = !Array.isArray(fileOrFiles) ? [fileOrFiles] : fileOrFiles;
            let archs = archOrArchs && !Array.isArray(archOrArchs) ? [archOrArchs] : archOrArchs;
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
            meteorPackage.addMeteorDependencies(packages, archs, opts);
          },
          imply(packageOrPackages, archOrArchs) {
            const packages = !Array.isArray(packageOrPackages) ? [packageOrPackages] : packageOrPackages;
            let archs = archOrArchs && !Array.isArray(archOrArchs) ? [archOrArchs] : archOrArchs;
            meteorPackage.addImplies(packages, archs);
          },
          addFiles(fileOrFiles, archOrArchs) {
            const files = !Array.isArray(fileOrFiles) ? [fileOrFiles] : fileOrFiles;
            let archs = archOrArchs && !Array.isArray(archOrArchs) ? [archOrArchs] : archOrArchs;
            // TODO: enable css, html, etc
            files.filter(file => file.endsWith('.js')).forEach((file) => {
              meteorPackage.addImport(`./${file}`, archs);
            });
          },
          mainModule(file, archOrArchs) {
            let archs = archOrArchs && !Array.isArray(archOrArchs) ? [archOrArchs] : archOrArchs;
            meteorPackage.setMainModule(file, archs);
          }
        });
      }
    }
  };
}
