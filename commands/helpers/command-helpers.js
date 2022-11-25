import _ from 'underscore';
import { error as errorLog } from '../../helpers/log';
import { LeafArchs } from '../../conversion/meteor-package';

const ClientArchs = LeafArchs.filter((archName) => archName !== 'server');
const ClientArchsSet = new Set(ClientArchs);
export const GlobalExportSymbol = Symbol('GlobalExportSymbol');

function getPackageExports(nodeName, clientOrServer, packagesMap, conditionalsMap) {
  try {
    const packageJson = packagesMap.get(nodeName);
    const implied = packageJson.meteorTmp?.implies?.filter(({ archs }) => !archs || archs.includes(clientOrServer));
    if (implied?.length) {
      implied.forEach(({ name: packageName }) => getPackageExports(
        packageName,
        clientOrServer,
        packagesMap,
        conditionalsMap,
      ));
    }

    /**
     * @type [{
     * name: String,
     * archs: [String],
     * debugOnly: Boolean,
     * testOnly: Boolean,
     * prodOnly: Boolean
     * }]
     */
    let exportedVars = [];
    if (Array.isArray(packageJson.meteorTmp?.exportedVars)) {
      exportedVars = packageJson.meteorTmp.exportedVars
        .filter(({ archs }) => {
          if (archs.includes(clientOrServer)) {
            return true;
          }
          if (clientOrServer === 'server') {
            return false;
          }
          return archs.find((archName) => ClientArchsSet.has(archName));
        });
    }
    else if (clientOrServer === 'server') {
      // deprecated
      exportedVars = (packageJson.meteorTmp?.exportedVars?.server || []).map((name) => ({ name, archs: ['server'] }));
    }
    else {
      // deprecated
      const allExportsForAllClientArchs = ['client', ...ClientArchs]
        .flatMap((archName) => (packageJson.meteorTmp?.exportedVars?.[archName] || []).map((name) => ({
          name,
          archName,
        })));
      const exportsByName = _.groupBy(allExportsForAllClientArchs, 'name');
      exportedVars = Object.entries(exportsByName).map(([name, arrObj]) => ({
        name,
        archs: arrObj.map(({ archName }) => archName),
      }));
    }
    let globalCondition;
    if (packageJson.exports['.'].development || packageJson.exports['.'].production) {
      globalCondition = packageJson.exports['.'].development ? 'development' : 'production';
    }
    exportedVars.forEach(({ name, archs, ...opts }) => {
      // the conditions array may look something like this:
      // [production, web.browser||web.cordova, debugOnly]
      const conditions = [];
      const relevantArchs = archs.filter((archName) => (clientOrServer === 'server' ? archName === 'server' : archName !== 'server'));
      if (globalCondition) {
        conditions.push(globalCondition);
      }
      if (!relevantArchs.includes(clientOrServer)) {
        conditions.push(relevantArchs.join('||'));
      }
      Object.entries(opts).forEach(([opt, value]) => {
        if (value) {
          conditions.push(opt);
        }
      });
      const conditionString = conditions.join('&&') || GlobalExportSymbol;
      if (!conditionalsMap.has(nodeName)) {
        conditionalsMap.set(nodeName, new Map());
      }
      const packageMap = conditionalsMap.get(nodeName);
      if (!packageMap.has(conditionString)) {
        packageMap.set(conditionString, new Set());
      }
      packageMap.get(conditionString).add(name);
    });
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
  const conditionalMap = new Map();

  nodePackagesVersionsAndExports.forEach(({ nodeName }) => getPackageExports(nodeName, clientOrServer, packagesMap, conditionalMap));
  return conditionalMap;
}
