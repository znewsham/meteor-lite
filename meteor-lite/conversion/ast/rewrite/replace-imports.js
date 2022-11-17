import { walk } from 'estree-walker';

// TODO: find a way to make this an option
const SERVER_ONLY_IMPORTS = new Set([
  'fibers',
  'util',
]);

export default function replaceImportsInAst(ast, isMultiArch, serverOnlyImportsSet) {
  if (!isMultiArch) {
    // if we're not multi-arch, don't bother rewriting.
    return;
  }
  walk(ast, {
    enter(node) {
      if (node.type === 'ImportDeclaration') {
        const rootImportSource = node.source.value.split('/')[0];
        if (SERVER_ONLY_IMPORTS.has(rootImportSource)) {
          if (rootImportSource !== node.source.value) {
            serverOnlyImportsSet.add(`${rootImportSource}/*`);
          }
          else {
            serverOnlyImportsSet.add(rootImportSource);
          }
          const quote = node.source.raw[0];
          this.replace({
            type: 'ImportDeclaration',
            specifiers: node.specifiers,
            source: {
              type: 'Literal',
              value: `#${node.source.value}`,
              raw: `${quote}${node.source.value}${quote}`,
            },
          });
        }
      }
    },
  });
}
