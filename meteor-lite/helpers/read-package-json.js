import fs from 'fs/promises';

export default async function readPackageJson(path = './package.json') {
  return JSON.parse((await fs.readFile(path)).toString());
}
