import { warn } from '../../helpers/log';

const archsToConditions = {
  'web.browser': 'Meteor.isModern',
  'web.browser.legacy': '!Meteor.isModern',
};

export default function dependencyEntry({
  nodeName,
  isLazy,
  onlyLoadIfProd,
  importSuffix,
  globalsMap,
  conditionalMap,
}) {
  if (isLazy) {
    return `import "${nodeName}/__defineOnly.js";`;
  }
  const globals = globalsMap.get(nodeName);
  if (onlyLoadIfProd) {
    warn(`prod-only package ${nodeName}, you need to add the correct conditional import yourself and add these if you expect the globals to be set. If you don't need the globals, no action is required`);
    return {};
  }
  const importName = onlyLoadIfProd ? `${nodeName.replace('@', '#').replace(/\//g, '_')}` : nodeName;
  if ((!globals || !globals.size) && !conditionalMap.has(nodeName)) {
    return { importToWrite: `import "${importName}";` };
  }
  const imp = `import * as __package_${importSuffix} from "${importName}";`;
  const conditionals = [];
  if (conditionalMap.has(nodeName)) {
    const conditionalsForPackage = conditionalMap.get(nodeName);
    Array.from(conditionalsForPackage.entries()).forEach(([archName, exp]) => {
      conditionals.push([
        `if (${archsToConditions[archName]}) {`,
        ...exp.map((global) => `globalThis.${global} = __package_${importSuffix}.${global}`),
        '}',
      ].join('\n'));
    });
  }
  return {
    importToWrite: imp,
    globalToWrite: [
      ...(onlyLoadIfProd ? ['if (Meteor.isProduction) {'] : []),
      ...Array.from(globals).map((global) => `globalThis.${global} = __package_${importSuffix}.${global}`),
      ...conditionals,
      ...(onlyLoadIfProd ? ['}'] : []),
    ].join('\n'),
  };
}
