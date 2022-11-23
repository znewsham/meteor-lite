import fs from 'fs/promises';
import path from 'path';
import { error as errorLog } from './log';

export default async function listFilesInDir(dir, depthOrBreadth = 'breadth') {
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
