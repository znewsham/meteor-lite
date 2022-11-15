import { walk } from 'estree-walker';

export default function maybeRewriteRequire(ast, debug) {
  let ret = false;
  walk(ast, {
    enter(node) {
      // require('meteor/whatever')
      if (
        node.type === 'CallExpression'
        && node.callee.type === 'Identifier'
        && node.callee.name === 'require'
        && node.arguments.length === 1
        && node.arguments[0].type === 'Literal'
        && node.arguments[0].value.startsWith('meteor/')
      ) {
        ret = true;
        node.__rewritten = true;
        if (node.arguments[0].value.includes(':')) {
          node.arguments[0].value = `@${node.arguments[0].value.replace('meteor/', '').split(':').join('/')}`;
        }
        else {
          node.arguments[0].value = `@${node.arguments[0].value}`;
        }
        node.arguments[0].raw = `"${node.arguments[0].value}"`;
      }
    },
  });
  return ret;
}
