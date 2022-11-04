import fs from 'fs/promises';
import crypto from 'crypto';
import fsExtra from 'fs-extra';
import path from 'path';
import { error as errorLog } from '../../helpers/log';

export const baseFolder = './.meteor';
export const baseBuildFolder = `${baseFolder}/local`;

function getPackageExports(nodeName, clientOrServer, packagesMap, exportsMap, conditionalsMap) {
  try {
    if (!exportsMap.has(nodeName)) {
      exportsMap.set(nodeName, new Set());
    }
    const packageJson = packagesMap.get(nodeName);

    if (packageJson.meteorTmp?.implies?.[clientOrServer]?.length) {
      packageJson.meteorTmp.implies[clientOrServer].map((packageName) => getPackageExports(
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

export async function readPackageJson() {
  return JSON.parse((await fs.readFile('./package.json')).toString());
}

export async function ensureBuildDirectory(name, outputBuildFolder = baseBuildFolder) {
  return fsExtra.ensureDir(`${outputBuildFolder}/${name}`);
}

export async function listFilesInDir(dir, depthOrBreadth = 'breadth') {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const inner = (await Promise.all(entries.filter((entry) => entry.isDirectory())
      .map((dirEnt) => listFilesInDir(path.join(dir, dirEnt.name)), depthOrBreadth))).flat();
    return [
      ...(depthOrBreadth === 'depth' ? inner : []),
      ...entries.filter((entry) => entry.isFile()).map((dirEnt) => path.join(dir, dirEnt.name)),
      ...(depthOrBreadth === 'breadth' ? inner : []),
    ];
  }
  catch (e) {
    errorLog(`problem with ${dir}`);
    errorLog(e);
    throw e;
  }
}

export async function getProgramEntry(asset) {
  const { file, ...remainderOfAsset } = asset;
  const buffer = await fs.readFile(file);
  const hashSum = crypto.createHash('sha256');
  hashSum.update(buffer);
  const hash = hashSum.digest('hex');
  return {
    where: 'client',
    hash,
    size: buffer.length,
    ...remainderOfAsset,
    url: asset.url || `/${remainderOfAsset.cacheable ? `${remainderOfAsset.path.replace(/^app\//, '')}?hash=${hash}` : remainderOfAsset.path.replace(/^app\//, '')}`,
  };
}

export async function generateProgram(allAssets) {
  const allAssetEntries = await Promise.all(allAssets.map(getProgramEntry));
  return {
    format: 'web-program-pre1',
    manifest: allAssetEntries,
  };
}
