import { error as errorLog } from '../../helpers/log';

function getPackageExports(nodeName, clientOrServer, packagesMap, exportsMap, conditionalsMap) {
  try {
    if (!exportsMap.has(nodeName)) {
      exportsMap.set(nodeName, new Set());
    }
    const packageJson = packagesMap.get(nodeName);
    const implied = packageJson.meteorTmp?.implies?.filter(({ archs }) => !archs || archs.includes(clientOrServer));
    if (implied?.length) {
      implied.map(({ name: packageName }) => getPackageExports(
        packageName,
        clientOrServer,
        packagesMap,
        exportsMap,
        conditionalsMap,
      ));
    }
    (packageJson.meteorTmp?.exportedVars?.[clientOrServer] || []).forEach((name) => exportsMap.get(nodeName).add(name));
    if (clientOrServer === 'client') {
      const webArchs = ['web.browser', 'web.browser.legacy'];
      const exportsForWebArchs = webArchs.map((webArchName) => packageJson.meteorTmp?.exportedVars?.[webArchName] || []);
      exportsForWebArchs.forEach((exp, index) => {
        if (exp.length) {
          if (!conditionalsMap.has(nodeName)) {
            conditionalsMap.set(nodeName, new Map());
          }
          conditionalsMap.get(nodeName).set(webArchs[index], exp);
        }
      });
    }
  }
  catch (e) {
    errorLog(new Error(`problem with package ${nodeName}`));
    errorLog(e);
    throw e;
  }
}

// NOTE: this could be implemented as a recurseMeteorNodePackages function, but we've already done that and got what we need.
export function generateGlobals(nodePackagesVersionsAndExports, clientOrServer) {
  const packagesMap = new Map();
  nodePackagesVersionsAndExports.forEach(({ nodeName, json }) => {
    packagesMap.set(nodeName, json);
  });
  const map = new Map();
  const conditionalMap = new Map();

  nodePackagesVersionsAndExports.forEach(({ nodeName }) => getPackageExports(nodeName, clientOrServer, packagesMap, map, conditionalMap));
  return {
    map,
    conditionalMap,
  };
}
