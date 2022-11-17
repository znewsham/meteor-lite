export function isExport(node) {
  return node.type === 'MemberExpression' && node.object.name === 'exports';
}

export function isModuleExport(node) {
  return node.type === 'MemberExpression'
    && node.object.name === 'module'
    && node.property.name === 'exports';
}

export function isRequire(node) {
  return node.type === 'CallExpression'
    && node.callee.type === 'Identifier'
    && node.callee.name === 'require';
}
