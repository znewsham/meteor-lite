import { walk } from 'estree-walker';
import { meteorNameToNodeName } from '../../../helpers/helpers';

const rewriteNodeTypes = new Set([
  'ImportDeclaration',
  'ExportNamedDeclaration',
  'ExportAllDeclaration',
]);
export default function maybeRewriteImportsOrExports(ast, debug) {
  let ret = false;
  walk(ast, {
    enter(node) {
      if (rewriteNodeTypes.has(node.type) && node.source?.value && node.source.value.startsWith('meteor/')) {
        ret = true;
        const nodeName = meteorNameToNodeName(node.source.value.replace('meteor/', ''));
        node.source.value = nodeName;
        node.source.raw = `'${node.source.value}'`;
      }
    },
  });

  return ret;
}
