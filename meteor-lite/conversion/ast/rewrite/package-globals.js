import { analyze as analyzeScope } from 'escope';
import { walk } from 'estree-walker';

function isVariableDeclaration(node, parent) {
  return parent.type === 'VariableDeclarator' && parent.id === node;
}

function isMemberProperty(node, parent) {
  return parent.type === 'MemberExpression' && parent.property === node && !parent.computed;
}

// class { alsoGlobalName = whatever } and { alsoGlobalName: whatever }
// but not class { [alsoGlobalName] = whatever }, { [alsoGlobalName]: whatever } or { whatever: alsoGlobalName }
function isProperty(node, parent) {
  return (parent.type === 'Property' || parent.type === 'PropertyDefinition') && parent.key === node && !parent.computed;
}

function isFunctionDeclarationOrExpression(node, parent) {
  return (parent.type === 'FunctionExpression' || parent.type === 'FunctionDeclaration')
    && (parent.id === node || parent.params.includes(node));
}

function isResolvedThroughScope(node, currentScope) {
  return currentScope.set.has(node.name)
    || currentScope.through.find((ref) => ref.resolved?.name === node.name);
}

const IgnoredParentTypes = new Set([
  'CatchClause',
  'ObjectPattern',
  'ExportSpecifier',
]);

export default function replacePackageGlobalsWithImportsOrRequire(ast, packageGlobalsSet) {
  if (packageGlobalsSet.size === 0) {
    return;
  }
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
  const parentsToRewrite = new Set();
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
      if (parentsToRewrite.has(node)) {
        this.replace({
          ...node,
          key: JSON.parse(JSON.stringify(node.key)),
          shorthand: false,
        });
        parentsToRewrite.delete(node);
        return;
      }
      if (acquired.has(node)) {
        acquired.delete(node);
        currentScope = currentScope.upper; // set to parent scope
      }
      if (
        node.type !== 'Identifier'
        || !packageGlobalsSet.has(node.name)
        || isResolvedThroughScope(node, currentScope)
      ) {
        return;
      }
      if (parent.type === 'Property' && parent.shorthand && parent.value === node) {
        parentsToRewrite.add(parent);
        this.replace({
          type: 'MemberExpression',
          object: {
            type: 'Identifier',
            name: '__package_globals__',
          },
          property: {
            type: 'Identifier',
            name: node.name,
          },
        });
        return;
      }
      if (
        IgnoredParentTypes.has(parent.type)
        || isVariableDeclaration(node, parent)
        || isMemberProperty(node, parent)
        || isProperty(node, parent)
        || isFunctionDeclarationOrExpression(node, parent)
      ) {
        return;
      }
      // simple rewrite
      this.replace({
        type: 'MemberExpression',
        object: {
          type: 'Identifier',
          name: '__package_globals__',
        },
        property: {
          type: 'Identifier',
          name: node.name,
        },
      });
    },
  });
}
