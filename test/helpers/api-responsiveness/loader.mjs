let providerUrl;
let boundaryUrl;
let calculatorUrl;

export function initialize(data) {
  ({ providerUrl, boundaryUrl, calculatorUrl } = data);
}

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (url === calculatorUrl) {
    const source = String(loaded.source);
    const declaration = 'export async function calculateVmCosts(';
    if (source.split(declaration).length !== 2) {
      throw new Error('Billing gateway signature changed; update the observer');
    }
    return {
      ...loaded,
      source:
        source.replace(
          declaration,
          'async function observedCalculateVmCosts(',
        ) +
        '\nimport { recordBillingGroups } from ' +
        JSON.stringify(boundaryUrl) +
        ';\n' +
        'export function calculateVmCosts(...args) {\n' +
        '  recordBillingGroups(args[0], args[1]);\n' +
        '  return observedCalculateVmCosts.apply(this, args);\n' +
        '}\n',
    };
  }
  if (url !== providerUrl) return loaded;
  const source = String(loaded.source);
  const declaration = 'export function createAwsCostExplorerClient(';
  if (source.split(declaration).length !== 2) {
    throw new Error(
      'Cost Explorer factory boundary changed; update the harness',
    );
  }
  // Preserve every other factory and the production allocator. Only this
  // audited client boundary receives synthetic responses.
  return {
    ...loaded,
    source:
      source.replace(declaration, 'function originalCostExplorerClient(') +
      '\nexport { createAwsCostExplorerClient } from ' +
      JSON.stringify(boundaryUrl) +
      ';\n',
  };
}
