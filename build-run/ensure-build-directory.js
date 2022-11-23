import fsExtra from 'fs-extra';
import { baseBuildFolder } from '../helpers/base-folder';

export default async function ensureBuildDirectory(name, outputBuildFolder = baseBuildFolder) {
  return fsExtra.ensureDir(`${outputBuildFolder}/${name}`);
}
