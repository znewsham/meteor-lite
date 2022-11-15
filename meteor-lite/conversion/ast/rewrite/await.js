import { walk } from 'estree-walker';

export default function maybeRewriteAwait(ast, multiArch, debug) {
  let ret = false;
  walk(ast, {
    leave(node) {
      if (
        node.type === 'AwaitExpression'
      ) {
        ret = true;
        const promiseAwait = {
          type: 'CallExpression',
          callee: {
            type: 'MemberExpression',
            object: {
              type: 'Identifier',
              name: 'Promise',
            },
            property: {
              type: 'Identifier',
              name: 'await',
            },
          },
          arguments: [node.argument],
        };
        if (multiArch) {
          this.replace({
            type: 'ConditionalExpression',
            test: {
              type: 'MemberExpression',
              object: {
                type: 'Identifier',
                name: 'Meteor',
              },
              property: {
                type: 'Identifier',
                name: 'isServer',
              },
            },
            consequent: promiseAwait,
            alternate: node,
          });
        }
        else {
          this.replace(promiseAwait);
        }
      }
    },
  });
  return ret;
}
