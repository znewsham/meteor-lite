import fs from 'fs-extra';
import os from 'os';
import path from 'path';

export async function getNpmRc() {
  const npmRcKeyValuePairs = new Map();
  const lines = [];
  if (await fs.pathExists(path.join(os.homedir(), '.npmrc'))) {
    lines.push(...(await fs.readFile(path.join(os.homedir(), '.npmrc'))).toString().split('\n'));
  }
  if (await fs.pathExists('.npmrc')) {
    lines.push(...(await fs.readFile('.npmrc')).toString().split('\n'));
  }
  lines.forEach((kv) => {
    const [key, value] = kv.trim().split(/\s*=\s*/);
    if (!key || key.startsWith('#')) {
      return;
    }
    npmRcKeyValuePairs.set(key, value);
  });
  return npmRcKeyValuePairs;
}

export async function registryForPackage(nodeName, npmRc) {
  if (nodeName.startsWith('@')) {
    const scope = nodeName.split('/')[0];
    const registry = npmRc.get(`${scope}:registry`);
    if (registry) {
      return registry;
    }
  }
  return undefined;
}
