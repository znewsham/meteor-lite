import { walk } from 'estree-walker';

export default function rewriteExports(ast) {
  const exported = [];
  walk(ast, {
    enter(node, parent) {
      if (parent?.type === 'AssignmentExpression' || parent?.type === 'VariableDeclarator') {
        return;
      }
      if (node.type === 'AssignmentExpression') {
        if (
          node.left.type === 'MemberExpression'
          && node.left.object.name === 'module'
          && node.left.property.name === 'exports'
        ) {
          node.__rewritten = true;
          node.type = 'ExportDefaultDeclaration';
          node.declaration = node.right;
          exported.push(null);
        }
        else if (
          node.left.type === 'MemberExpression'
          && (
            node.left.object.name === 'exports'
            || (
              node.left.object.type === 'MemberExpression'
              && node.left.object.object.name === 'module'
              && node.left.object.property.name === 'exports'
            )
          )
        ) {
          node.__rewritten = true;
          node.type = 'ExportNamedDeclaration';
          exported.push(node.left.property.name);
          if (node.left.property.name === node.right.name) {
            node.specifiers = [{
              type: 'ExportSpecifier',
              exported: {
                type: 'Identifier',
                name: node.right.name,
              },
              local: {
                type: 'Identifier',
                name: node.right.name,
              },
            }];
          }
          else {
            node.declaration = {
              type: 'VariableDeclaration',
              kind: 'var',
              declarations: [{
                type: 'VariableDeclarator',
                id: {
                  type: 'Identifier',
                  name: node.left.property.name,
                },
                init: node.right,
              }],
            };
          }
        }
      }
    },
  });

  return exported;
}
