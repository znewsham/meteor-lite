import { walk } from 'estree-walker';
import { isExport, isModuleExport } from './helpers';

export default function rewriteExports(ast) {
  const exported = [];
  walk(ast, {
    enter(node, parent) {
      if (parent?.type === 'AssignmentExpression' || parent?.type === 'VariableDeclarator') {
        return;
      }
      if (node.type === 'AssignmentExpression') {
        if (isModuleExport(node.left)) {
          this.replace({
            type: 'ExportDefaultDeclaration',
            declaration: node.right,
          });
          exported.push(null);
        }
        else if (isExport(node.left) || (node.left.object && isModuleExport(node.left.object))) {
          exported.push(node.left.property.name);
          if (node.left.property.name === node.right.name) {
            this.replace({
              type: 'ExportNamedDeclaration',
              specifiers: [{
                type: 'ExportSpecifier',
                exported: {
                  type: 'Identifier',
                  name: node.right.name,
                },
                local: {
                  type: 'Identifier',
                  name: node.right.name,
                },
              }],
            });
          }
          else {
            this.replace({
              type: 'ExportNamedDeclaration',
              declaration: {
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
              },
            });
          }
        }
      }
    },
  });

  return exported;
}
