import * as acorn from 'acorn';
import * as acornLoose from 'acorn-loose';
import { walk } from 'estree-walker';
import fsPromises from 'fs/promises';
import { attachComments } from 'estree-util-attach-comments';
import { parse, print } from 'recast';
import { generate } from 'astring';
import { resolveFile } from '../imports.js';
import { acornOptions } from '../acorn-options.js';
import rewriteExports from './rewrite/exports.js';

const warnedAboutRecast = new Set();

export function parseContentsToAST(contents, {
  attachComments: shouldAttachComments = false,
  loose = false,
  file,
  raw = false,
} = {}) {
  const comments = [];
  const parser = loose ? acornLoose : acorn;
  try {
    let ast;
    if (raw) {
      ast = parser.parse(contents, {
        ...acornOptions,
        ...(shouldAttachComments && { onComment: comments }),
      });
      if (shouldAttachComments) {
        attachComments(ast, comments);
      }
      return ast;
    }
    ast = parse(contents, {
      parser: {
        parse(src) {
          return parser.parse(src, {
            ...acornOptions,
          });
        },
      },
    });
    return ast.program;
  }
  catch (error) {
    if (!raw) {
      try {
        const ret = parseContentsToAST(contents, {
          attachComments: shouldAttachComments,
          loose,
          file,
          raw: true,
        });
        if (file && !warnedAboutRecast.has(file)) {
          // this was too noisy - but if we move to an event emitter might be useful
          // warn(`${file || 'unknown file'} couldn't be parsed with recast, the structure and comments will possibly be lost`);
          warnedAboutRecast.add(file);
        }
        return ret;
      }
      catch (e) {
        // do nothing
      }
    }
    if (file) {
      error.message = `${file}${loose ? ' (loose) ' : ''}: ${error.message}`;
    }
    // we're throwing a new error because the stack we get is totally useless
    throw new Error(error.message);
  }
}

export function astToCode(ast) {
  try {
    const { code } = print(ast);

    // sometimes recast generates code that can't be parsed - something wrong with what we're doing + comments.
    // An exampel is qualia:core/lib/helpers.js where a comment is bumped *down* a line and converted to a leading comment
    // which effectively comments out a closing brace
    // HACK: remove this, it's so horrible.
    parseContentsToAST(code);
    return code;
  }
  catch (e) {
    return generate(ast);
  }
}

function getExportNamedDeclarationNodes(ast) {
  const nodes = [];
  walk(ast, {
    enter(node, parent) {
      if (node.type === 'ExportNamedDeclaration') {
        nodes.push({ node, parent, type: 'export' });
      }
    },
  });
  return nodes;
}

const reservedKeywords = new Set(['package', 'public']);

function getReservedUsage(ast) {
  const packageNodes = [];
  walk(ast, {
    enter(node, parent) {
      if (node.type === 'Identifier' && reservedKeywords.has(node.name)) {
        packageNodes.push({ node, parent, type: 'reserved' });
      }
    },
  });
  return packageNodes;
}

async function getCleanAST(file) {
  try {
    let contents = (await fsPromises.readFile(file)).toString();
    let ast;
    try {
      ast = parseContentsToAST(
        contents,
        {
          file,
          attachComments: true,
        },
      );
      return { ast, requiresCleaning: false };
    }
    catch (e) {
      // acorn-loose incorrectly parses things that acorn can parse correctly (wildly)
      // an example is qualia:core/lib/helpers.js where daysBetweenUsing365DayYear gets "replaced" with a unicode X
      // so if we fail to parse with acorn, we parse with acornLoose and manually fix the exported globals (hopefully the reason)
      // then re-parse with acorn.

      ast = parseContentsToAST(
        contents,
        {
          loose: true,
          attachComments: true,
        },
      );
      const all = [
        ...getReservedUsage(ast),
        ...getExportNamedDeclarationNodes(ast),
      ];
      all.sort((a, b) => b.node.start - a.node.start);
      all.forEach(({ node, type }) => {
        const prefix = contents.slice(0, node.start);
        const suffix = contents.slice(node.end);
        if (type === 'export') {
          const declaration = node.specifiers.map((specifier) => {
            const ret = `const _${specifier.local.name} = ${specifier.local.name}`;
            specifier.exported = JSON.parse(JSON.stringify(specifier.local));
            specifier.local.name = `_${specifier.local.name}`;
            return ret;
          }).join('\n');
          contents = `${prefix}\n${declaration}\n${astToCode(node)}\n${suffix}`;
        }
        else if (type === 'reserved') {
          contents = `${prefix}___${node.name}${suffix}`;
        }
      });
      ast = parseContentsToAST(
        contents,
        {
          file,
          attachComments: true,
        },
      );
      return { ast, requiresCleaning: true };
    }
  }
  catch (e) {
    console.log('problem with file', file);
    throw e;
  }
}

export async function maybeCleanAST(file, isCommon, exportedMap) {
  if (!file.endsWith('.js')) {
    const resolvedFile = await resolveFile(file);
    if (!resolvedFile.endsWith('.js')) { // TODO: ts
      return;
    }
  }
  const { ast, requiresCleaning } = await getCleanAST(file);
  const importEntries = new Map();
  const importReplacementPrefix = '_import_require_';
  let blockDepth = 0;
  let hasImports = false;
  let hasRequires = false;
  let usesExports = false;
  let usesUncleanExports = false;
  if (!isCommon) {
    walk(ast, {
      leave(node) {
        if (node.type === 'BlockStatement') {
          blockDepth -= 1;
        }
      },
      enter(node) {
        if (node.type === 'AssignmentExpression') {
          if (
            node.left.type === 'MemberExpression'
            && (
              node.left.object.name === 'exports'
              || (node.left.object.type === 'MemberExpression' && node.left.object.object.name === 'module' && node.left.object.property.name === 'exports')
            )
          ) {
            if (!usesUncleanExports) {
              usesUncleanExports = blockDepth !== 0;
            }
            usesExports = true;
          }
        }
        if (node.type === 'BlockStatement') {
          blockDepth += 1;
        }
        if (node.type === 'ImportDeclaration') {
          hasImports = true;
        }
        if (
          node.type === 'CallExpression'
          && node.callee.type === 'Identifier'
          && node.callee.name === 'require'
          && node.arguments.length === 1
          && node.arguments[0].type === 'Literal'
        ) {
          if (blockDepth !== 0 || isCommon) {
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
          // TODO: if the parent is a body node, this isn't necessary
          // e.g., require(x) can be entirely ommitted y = require(x) must be rewritten
          node.__rewritten = true;
          node.type = 'LogicalExpression';
          node.operator = '||';
          node.right = {
            type: 'Identifier',
            name: importEntry.name,
          };
          node.left = {
            type: 'MemberExpression',
            object: {
              type: 'Identifier',
              name: importEntry.name,
            },
            property: {
              type: 'Identifier',
              name: 'default',
            },
          };
        }
      },
    });
  }
  let exported;
  let importAstBodyIndex = 0;
  if (usesExports && !hasRequires && !usesUncleanExports) {
    exported = rewriteExports(ast);
    exportedMap.set(file, exported);
  }
  if (requiresCleaning || importEntries.size || exported?.length) {
    importEntries.forEach(({ node }) => {
      ast.body.splice(importAstBodyIndex++, 0, node);
    });
    if (hasRequires && hasImports) {
      throw new Error(`Imports and requires in ${file} (un-fixable)`);
    }
    if (hasRequires && importEntries.size) {
      //throw new Error(`Imports and requires in ${file} (fixable)`);
    }
    await fsPromises.writeFile(file, astToCode(ast));
  }
  return ast;
}
