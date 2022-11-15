import { walk } from 'estree-walker';

// TODO: find a way to make this an option
const SERVER_ONLY_IMPORTS = new Set([
  'fibers',
  'util',
]);

export default function replaceImportsInAst(ast, isMultiArch, serverOnlyImportsSet, file) {
  if (!isMultiArch) {
    // if we're not multi-arch, don't bother rewriting.
    return;
  }
  walk(ast, {
    enter(node) {
      if (node.type === 'ImportDeclaration') {
        const rootImportSource = node.source.value.split('/')[0];
        if (SERVER_ONLY_IMPORTS.has(rootImportSource)) {
          node.__rewritten = true;
          if (rootImportSource !== node.source.value) {
            serverOnlyImportsSet.add(`${rootImportSource}/*`);
          }
          else {
            serverOnlyImportsSet.add(rootImportSource);
          }
          node.source.value = `#${node.source.value}`;
          node.source.raw = `'${node.source.value}'`;
        }
      }
    },
  });
}
