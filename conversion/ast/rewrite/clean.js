import { walk } from 'estree-walker';
import { isExport, isModuleExport, isRequire } from './helpers';

const importReplacementPrefix = '_import_require_';

export default function clean(ast) {
  let blockDepth = 0;
  let hasImports = false;
  let hasRequires = false;
  let usesExports = false;
  let usesUncleanExports = false;
  const importEntries = new Map();

  walk(ast, {
    leave(node) {
      // probably others but we're catching for if (x) module.exports = whatever
      if (node.type === 'BlockStatement' || node.type === 'IfStatement') {
        blockDepth -= 1;
      }
    },
    enter(node, parent) {
      if (node.type === 'AssignmentExpression') {
        if (
          isExport(node.left)
          || isModuleExport(node.left)
          || (node.left.object && isModuleExport(node.left.object))
        ) {
          if (!usesUncleanExports) {
            usesUncleanExports = blockDepth !== 0 || parent.type === '';
          }
          usesExports = true;
        }
      }
      if (node.type === 'BlockStatement' || node.type === 'IfStatement') {
        blockDepth += 1;
      }
      if (node.type === 'ImportDeclaration') {
        hasImports = true;
      }
      if (
        isRequire(node)
        && node.arguments.length === 1
        && node.arguments[0].type === 'Literal'
      ) {
        if (blockDepth !== 0) {
          hasRequires = true;
          return;
        }
        const importPath = node.arguments[0].value;
        let importEntry;
        if (importEntries.has(importPath)) {
          importEntry = importEntries.get(importPath);
        }
        else {
          const name = `${importReplacementPrefix}${importEntries.size + 1}`;
          importEntry = {
            name,
            node: {
              type: 'ImportDeclaration',
              source: {
                type: 'Literal',
                value: node.arguments[0].value,
                raw: node.arguments[0].raw,
              },
              specifiers: [{
                type: 'ImportNamespaceSpecifier',
                local: {
                  type: 'Identifier',
                  name,
                },
              }],
            },
          };
          importEntries.set(importPath, importEntry);
        }
        // NOTE: if the parent is a body node, this isn't necessary
        // e.g., require(x) can be entirely ommitted y = require(x) must be rewritten
        this.replace({
          type: 'LogicalExpression',
          operator: '||',
          right: {
            type: 'Identifier',
            name: importEntry.name,
          },
          left: {
            type: 'MemberExpression',
            object: {
              type: 'Identifier',
              name: importEntry.name,
            },
            property: {
              type: 'Identifier',
              name: 'default',
            },
          },
        });
      }
    },
  });

  return {
    hasImports,
    hasRequires,
    usesExports,
    usesUncleanExports,
    importEntries,
  };
}
