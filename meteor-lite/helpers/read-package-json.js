import fs from 'fs-extra';
import path from 'path';
import pacote from 'pacote';
import { registryForPackage } from './ensure-npm-rc';

export async function readPackageJsonForPackage(nodeName, outputFolder, npmRc) {
  const pathToPackageJson = path.join(outputFolder, 'package.json');
  if (await (fs.pathExists(pathToPackageJson))) {
    return JSON.parse((await fs.readFile(pathToPackageJson)).toString());
  }
  const registry = await registryForPackage(nodeName, npmRc);
  if (registry) {
    const packageSpec = nodeName; // TODO: version
    const options = {
      fullReadJson: true,
      fullMetadata: true,
      where: process.cwd(),
      registry,
    };
    return pacote.manifest(packageSpec, options);
  }
  throw new Error(`Couldn't find package ${nodeName} in ${outputFolder} or NPM`);
}
