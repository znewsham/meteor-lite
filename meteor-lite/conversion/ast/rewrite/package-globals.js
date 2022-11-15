import { walk } from 'estree-walker';
import { analyze as analyzeScope } from 'escope';
import replaceImportsInAst from './replace-imports';

export default function rewriteASTForPackageGlobals(ast, packageGlobalsSet, isMultiArch, serverOnlyImportsSet, file) {
  const scopeManager = analyzeScope(ast, {
    ecmaVersion: 6,
    sourceType: 'module',
    ignoreEval: true,
    // Ensures we don't treat top-level var declarations as globals.
    nodejsScope: true,
  });
  let currentScope = scopeManager.acquire(ast);
  const stack = [];
  const acquired = new Set();
  replaceImportsInAst(ast, isMultiArch, serverOnlyImportsSet, file);
  walk(ast, {
    enter(node) {
      stack.push(node);
      if (scopeManager.acquire(node)) {
        acquired.add(node);
        currentScope = scopeManager.acquire(node); // get current function scope
      }
    },
    leave(node, parent) {
      stack.pop();
      if (acquired.has(node)) {
        acquired.delete(node);
        currentScope = currentScope.upper; // set to parent scope
      }
      if (
        node.type !== 'Identifier'
        || !packageGlobalsSet.has(node.name)
        || currentScope.set.has(node.name)
        || currentScope.through.find((ref) => ref.resolved?.name === node.name)
      ) {
        return;
      }

      if (parent.type === 'Property' && parent.shorthand && parent.value === node) {
        parent.key = JSON.parse(JSON.stringify(parent.key));
        parent.shorthand = false;
        node.__rewritten = true;
        parent.__rewritten = true;
        node.type = 'MemberExpression';
        node.object = {
          type: 'Identifier',
          name: '__package_globals__',
        };
        node.property = {
          type: 'Identifier',
          name: node.name,
        };
        return;
      }
      // simple rewrite
      if (
        (parent.type !== 'VariableDeclarator' || parent.id !== node)
        && (parent.type !== 'MemberExpression' || parent.object === node || parent.computed === true)
        && (parent.type !== 'Property' || parent.value === node)
        && parent.type !== 'CatchClause'
        && parent.type !== 'ObjectPattern'
        && parent.type !== 'PropertyDefinition'
        && (parent.type !== 'FunctionExpression' || node === parent.left)
        && (parent.type !== 'FunctionDeclaration' || node === parent.id)
      ) {
        node.__rewritten = true;
        node.type = 'MemberExpression';
        node.object = {
          type: 'Identifier',
          name: '__package_globals__',
        };
        node.property = {
          type: 'Identifier',
          name: node.name,
        };
      }
    },
  });
}
