import { walk } from 'estree-walker';
import { meteorNameToNodeName } from '../../../helpers/helpers';
import { isRequire } from './helpers';


export default function maybeRewriteRequire(ast) {
  let ret = false;
  walk(ast, {
    enter(node, parent) {
      if (
        // require('meteor/whatever')
        node.type === 'Literal'
        && isRequire(parent)
        && node.value.startsWith('meteor/')
      ) {
        ret = true;
        const nodeName = meteorNameToNodeName(node.value.replace('meteor/', ''));
        const quote = node.raw[0];
        this.replace({
          type: 'Literal',
          value: nodeName,
          raw: `${quote}${nodeName}${quote}`,
        });
      }
    },
  });
  return ret;
}
