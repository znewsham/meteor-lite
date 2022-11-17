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
import clean from './rewrite/clean.js';

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
            ...(shouldAttachComments && { onComment: comments }),
          });
        },
      },
    });
    // at a glance it seems like you shouldn't need this - but that's only because recast caches nodes
    // e.g., if a node is unchanged, it prints it's exact representation
    // so if a node is unchanged it's comments remain, but we want to keep *all* comments
    // it also isn't clear at what level a change will impact comments - best to attach them manually if possible
    if (shouldAttachComments) {
      attachComments(ast, comments);
    }
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
  if (!file.endsWith('.js') && !file.endsWith('.ts')) {
    const resolvedFile = await resolveFile(file);
    if (!resolvedFile.endsWith('.js') && !resolvedFile.endsWith('.ts')) {
      throw new Error(`tried to parse a non JS file ${file} resolved to ${resolvedFile}`);
    }
  }
  const { ast, requiresCleaning } = await getCleanAST(file);
  const {
    hasImports = false,
    hasRequires = false,
    usesExports = false,
    usesUncleanExports = false,
    importEntries = new Set(),
  } = isCommon ? {} : clean(ast);
  let exported;
  let importAstBodyIndex = 0;
  if (usesExports && !hasRequires && !usesUncleanExports) {
    exported = rewriteExports(ast);
    exportedMap.set(file, exported);
  }
  if (requiresCleaning || importEntries.size || exported?.length) {
    importEntries.forEach(({ node }) => {
      importAstBodyIndex += 1;
      ast.body.splice(importAstBodyIndex, 0, node);
    });
    if (hasRequires && hasImports) {
      throw new Error(`Imports and requires in ${file} (un-fixable)`);
    }
    await fsPromises.writeFile(file, astToCode(ast));
  }
  return ast;
}
