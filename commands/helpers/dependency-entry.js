import { warn } from '../../helpers/log';
import { GlobalExportSymbol } from './command-helpers';

// YES Meteor.isProduction && Meteor.isDevelopment is technically relevant
// if a package is prodOnly but exports a debugOnly export (stupid, but technically possible)
const exportConditionsToCodeSnippet = {
  production: 'Meteor.isProduction',
  development: 'Meteor.isDevelopment',
  testOnly: '(Meteor.isTest || Meteor.isAppTest)',
  debugOnly: 'Meteor.isDevelopment',
  prodOnly: 'Meteor.isProduction',

  // these only work because the file will only be loaded on the client, otherwise we'd need a Meteor.isClient
  'web.browser': 'Meteor.isModern',
  'web.browser.legacy': '!Meteor.isModern',
  'web.cordova': 'Meteor.isCordova',
};

export default function dependencyEntry({
  nodeName,
  isLazy,
  // this will be true if a package is imported/implied by another prodOnly package
  // in this case we must not even import the package
  onlyLoadIfProd,
  onlyLoadIfDev,
  // this will be true if a package is neither a direct dependency, nor an implied package of a direct dependency
  // in this case we must import the package, but declare the exports
  isIndirectDependency,
  importSuffix,
  conditionalMap,
}) {
  if (isLazy) {
    return `import "${nodeName}/__defineOnly.js";`;
  }
  const conditionals = conditionalMap.get(nodeName);
  if (onlyLoadIfProd || onlyLoadIfDev) {
    return {};
  }
  if (!conditionals || !conditionals.size || isIndirectDependency) {
    return { importToWrite: `import "${nodeName}";` };
  }
  const imp = `import * as __package_${importSuffix} from "${nodeName}";`;
  return {
    importToWrite: imp,
    globalToWrite: Array.from(conditionals.entries()).map(([condition, nameSet]) => {
      const exportStrs = Array.from(nameSet).map((global) => `globalThis.${global} = __package_${importSuffix}.${global}`);
      if (condition === GlobalExportSymbol) {
        return exportStrs.join('\n');
      }
      const conditionalCodeString = condition.split('&&').map((conditionPart) => {
        const subParts = conditionPart.split('||');
        const str = subParts.map((subPart) => exportConditionsToCodeSnippet[subPart]).join(' || ');
        if (subParts.length === 1) {
          return str;
        }
        return `(${str})`;
      }).join(' && ');

      return [
        `if (${conditionalCodeString}) {`,
        ...exportStrs.map((str) => `  ${str}`),
        '}',
      ].join('\n');
    }).join('\n'),
  };
}
