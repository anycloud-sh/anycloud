import { dirname, isAbsolute, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function memberName(node) {
  if (node.type !== 'MemberExpression') return undefined;
  if (!node.computed && node.property.type === 'Identifier') {
    return node.property.name;
  }
  if (node.computed && node.property.type === 'Literal') {
    return typeof node.property.value === 'string'
      ? node.property.value
      : undefined;
  }
  return undefined;
}

function identifierName(node) {
  return node.type === 'Identifier' ? node.name : undefined;
}

function normalizedAbsolutePath(path, cwd) {
  const absolutePath = isAbsolute(path) ? path : resolve(cwd, path);
  return normalize(absolutePath).replaceAll('\\', '/');
}

function contextCwd(context) {
  return context.cwd ?? context.getCwd?.() ?? process.cwd();
}

function normalizedFilename(context) {
  const filename =
    context.getPhysicalFilename?.() ?? context.getFilename?.() ?? '<input>';
  return normalizedAbsolutePath(filename, contextCwd(context));
}

function normalizedModuleIdentity(path, cwd) {
  return normalizedAbsolutePath(path, cwd).replace(/\.[cm]?[jt]sx?$/u, '');
}

function localModulePath(source) {
  if (typeof source !== 'string') return undefined;
  if (source.startsWith('file:')) {
    try {
      return fileURLToPath(source);
    } catch {
      return undefined;
    }
  }
  if (!source.startsWith('.') && !isAbsolute(source)) return undefined;
  return source.replace(/[?#].*$/u, '');
}

function resolvedImportIdentity(source, importer, cwd) {
  const path = localModulePath(source);
  if (!path) return undefined;
  const resolved = isAbsolute(path) ? path : resolve(dirname(importer), path);
  return normalizedModuleIdentity(resolved, cwd);
}

function literalModuleSpecifier(node) {
  const expression = unwrapExpression(node);
  if (expression?.type === 'Literal' && typeof expression.value === 'string') {
    return expression.value;
  }
  if (
    expression?.type === 'TemplateLiteral' &&
    expression.expressions.length === 0
  ) {
    return expression.quasis[0]?.value.cooked;
  }
  return undefined;
}

function resolvedVariable(context, identifier) {
  if (identifier?.type !== 'Identifier') return undefined;
  const sourceCode = context.sourceCode ?? context.getSourceCode();
  let scope = sourceCode.getScope(identifier);
  while (scope) {
    const variable = scope.set.get(identifier.name);
    if (variable) return variable;
    scope = scope.upper;
  }
  return undefined;
}

function isUnshadowedGlobal(context, identifier, name) {
  if (identifier?.type !== 'Identifier' || identifier.name !== name) {
    return false;
  }
  const variable = resolvedVariable(context, identifier);
  return variable === undefined || variable.defs.length === 0;
}

function assignedIdentifier(pattern) {
  if (pattern?.type === 'Identifier') return pattern;
  if (
    pattern?.type === 'AssignmentPattern' &&
    pattern.left.type === 'Identifier'
  ) {
    return pattern.left;
  }
  return undefined;
}

function isAllowedOwner(context) {
  const filename = normalizedFilename(context);
  const cwd = contextCwd(context);
  const allowedFiles = context.options[0]?.allowedFiles ?? [];
  return allowedFiles.some(
    (allowedFile) => filename === normalizedAbsolutePath(allowedFile, cwd),
  );
}

const ownershipRuleSchema = [
  {
    type: 'object',
    properties: {
      allowedFiles: {
        type: 'array',
        items: { type: 'string' },
        uniqueItems: true,
      },
      checkBuilderCalls: { type: 'boolean' },
    },
    required: ['allowedFiles'],
    additionalProperties: false,
  },
];

// Threat model. This rule and the graph defend two tiers: accidental
// boundary crossings, and casual evasion — any load whose loader name or
// module specifier still appears literally (identifier, string, or
// substitution-free template) at the point of use. The defense is flat
// prohibition: the names below cannot appear in guarded scopes in ANY
// position — reference, binding, property, key, label, or import name — so
// there is no alias, spelling, or position left to analyze. Above the
// ceiling — runtime CONSTRUCTION of a loader or key (computed keys from
// variables, concatenated strings, `globalThis.module` in CommonJS,
// worker_threads, vm, child_process) — is review territory, per
// CONTRIBUTING: these checks constrain reviewed source; they are not a
// sandbox. The eval family is closed by core no-eval/no-implied-eval/
// no-new-func in eslint.config.mjs, and dependency-cruiser
// (`yarn check:graph`) checks every load this rule admits.
const MODULE_CAPABILITY_SOURCES = new Set(['module', 'node:module']);
// eval and Function are loader-equivalent: their string argument can mint
// a graph-invisible dynamic import, and the core no-eval family only sees
// direct spellings. Function stays legal as a type annotation.
const BANNED_LOADER_NAMES = new Set([
  'Function',
  'eval',
  'getBuiltinModule',
  'module',
  'require',
]);
// 'module' stays legal as a string: `sourceType: 'module'` is ordinary data.
const BANNED_LOADER_STRINGS = new Set([
  'Function',
  'eval',
  'getBuiltinModule',
  'require',
]);

const literalModuleLoads = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Keep every production module load visible to the dependency graph by requiring static imports and banning loader capabilities.',
    },
    schema: [],
    messages: {
      bannedName:
        "The name '{{name}}' cannot appear in graph-checked scopes in any position; every spelling of the CommonJS loader hides loads from the dependency graph. Choose another name.",
      bannedString:
        "The string '{{name}}' names a module-loading capability and cannot appear in graph-checked scopes.",
      capability:
        'Loading the node:module capability hides dependencies from the graph check. Use static imports instead.',
      dynamicImport:
        'Dynamic module loading is not allowed in production source; use a static import so the dependency graph remains complete.',
      schemeSpecifier:
        'A specifier must be a relative path, a bare package name, or a node: built-in — absolute paths and URL schemes (data:, file:, https:) carry loads the graph rules cannot match.',
      typeExpression:
        'Type-position import() expressions obscure erased dependencies in the graph. Use an `import type` statement instead.',
    },
  },
  create(context) {
    // A specifier may be relative, a bare package name, or node: scheme.
    // URL schemes (data:, file:, https:) smuggle executable or off-graph
    // content through a literal, and an absolute path resolves to a target
    // the repo-relative graph rules cannot match.
    function hasForbiddenScheme(specifier) {
      return (
        specifier.startsWith('/') ||
        specifier.startsWith('#') ||
        (/^[a-z][a-z0-9+.-]*:/iu.test(specifier) &&
          !specifier.startsWith('node:'))
      );
    }

    // Shape applies to every specifier, erased or not: an absolute or
    // URL-scheme `import type` resolves to an edge the graph's rules
    // cannot match. Only the capability check is waived for erased
    // imports.
    function checkStaticSpecifier(sourceNode, typeOnly = false) {
      const source = literalModuleSpecifier(sourceNode);
      if (source === undefined) return;
      if (hasForbiddenScheme(source)) {
        context.report({ node: sourceNode, messageId: 'schemeSpecifier' });
        return;
      }
      if (!typeOnly && MODULE_CAPABILITY_SOURCES.has(source)) {
        context.report({ node: sourceNode, messageId: 'capability' });
      }
    }

    return {
      Identifier(node) {
        if (
          node.name === 'Function' &&
          node.parent.type === 'TSTypeReference'
        ) {
          return;
        }
        if (BANNED_LOADER_NAMES.has(node.name)) {
          context.report({
            node,
            messageId: 'bannedName',
            data: { name: node.name },
          });
        }
      },
      Literal(node) {
        if (
          typeof node.value === 'string' &&
          BANNED_LOADER_STRINGS.has(node.value)
        ) {
          context.report({
            node,
            messageId: 'bannedString',
            data: { name: node.value },
          });
        }
      },
      TemplateLiteral(node) {
        const value =
          node.expressions.length === 0
            ? node.quasis[0]?.value.cooked
            : undefined;
        if (value !== undefined && BANNED_LOADER_STRINGS.has(value)) {
          context.report({
            node,
            messageId: 'bannedString',
            data: { name: value },
          });
        }
      },
      ImportDeclaration(node) {
        const typeOnly =
          node.importKind === 'type' ||
          (node.specifiers.length > 0 &&
            node.specifiers.every(
              (specifier) => specifier.importKind === 'type',
            ));
        checkStaticSpecifier(node.source, typeOnly);
      },
      ExportNamedDeclaration(node) {
        if (!node.source) return;
        const typeOnly =
          node.exportKind === 'type' ||
          (node.specifiers.length > 0 &&
            node.specifiers.every(
              (specifier) => specifier.exportKind === 'type',
            ));
        checkStaticSpecifier(node.source, typeOnly);
      },
      ExportAllDeclaration(node) {
        checkStaticSpecifier(node.source, node.exportKind === 'type');
      },
      ImportExpression(node) {
        context.report({ node, messageId: 'dynamicImport' });
      },
      CallExpression(node) {
        if (node.callee.type === 'Import') {
          context.report({ node, messageId: 'dynamicImport' });
        }
      },
      TSImportType(node) {
        context.report({ node, messageId: 'typeExpression' });
      },
      // `import X = require(...)` spells the CommonJS loader without an
      // Identifier node; it is the one non-identifier spelling TS grammar
      // has, and it is banned like the name itself.
      TSImportEqualsDeclaration(node) {
        context.report({
          node,
          messageId: 'bannedName',
          data: { name: 'require' },
        });
      },
    };
  },
};

const containerSpecWriteOwners = {
  // The one insert, which each owner's creation calls in its transaction.
  'src/api/services/container-spec.ts': ['insertContainerSpec'],
  'src/api/services/repositories/workload-lifecycle.ts': [
    'WorkloadLifecycleStore.beginServiceUpgrade',
  ],
};

const containerSpecWriteOwnership = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Confine canonical container-spec SQL writes to registered resource-owner methods and the startup migration.',
    },
    schema: [],
    messages: {
      owner:
        'Container-spec writes belong to the registered resource-owner methods or numbered startup migration.',
      dynamicTarget:
        'SQL mutation schema and table names must be statically visible; do not construct them dynamically.',
    },
  },
  create(context) {
    const file = normalizedFilename(context);
    const owners = new Set(
      Object.entries(containerSpecWriteOwners).find(
        ([ownerFile]) =>
          normalizedAbsolutePath(ownerFile, contextCwd(context)) === file,
      )?.[1],
    );
    const unknownPart = '\u0000';
    const quotedIdentifier =
      /"(?:[^"]|"")*(?:"|$)|'(?:[^']|'')*(?:'|$)|`(?:[^`]|``)*(?:`|$)|\[[^\]]*(?:\]|$)/u
        .source;
    const identifier = `(?:${quotedIdentifier}|[\\w$\\u0000]+)`;
    const gap = '[\\s\\u0000]*';
    const separator = '[\\s\\u0000]+';
    const commentsOrQuotes = new RegExp(
      `${quotedIdentifier}|/\\*[\\s\\S]*?(?:\\*/|$)|--[^\\n]*`,
      'gu',
    );
    const dataMutationPrefix =
      `(?:INSERT${separator}(?:OR${separator}[\\w\\u0000]+${separator})?INTO|` +
      `REPLACE${separator}INTO|` +
      `UPDATE\\b(?:${separator}OR${separator}[\\w\\u0000]+)?|` +
      `DELETE${separator}FROM)`;
    const tableDdlPrefix =
      `(?:CREATE${separator}(?:(?:TEMP|TEMPORARY)${separator}TABLE|VIRTUAL${separator}TABLE|TABLE)${separator}` +
      `(?:IF${separator}NOT${separator}EXISTS${separator})?|` +
      `ALTER${separator}TABLE${separator}|` +
      `DROP${separator}TABLE${separator}(?:IF${separator}EXISTS${separator})?)`;
    // Consume quoted data before searching for the next mutation. Quotes in a
    // mutation's target are consumed by that earlier match instead.
    const writeTargets = new RegExp(
      `${quotedIdentifier}|\\b(?:${dataMutationPrefix}|${tableDdlPrefix})${gap}(${identifier})(?:${gap}\\.${gap}(${identifier}))?`,
      'giu',
    );
    const sqliteStatementStart =
      /^\s*(?:;\s*)*(?:ALTER|ANALYZE|ATTACH|BEGIN|COMMIT|CREATE|DELETE|DETACH|DROP|END|EXPLAIN|INSERT|PRAGMA|REINDEX|RELEASE|REPLACE|ROLLBACK|SAVEPOINT|SELECT|UPDATE|VACUUM|VALUES|WITH)\b/iu;

    // This is a source-shape guard, not a SQL/dataflow engine: fold literal
    // pieces, retain unknown expressions, and leave opaque SQL forwarding and
    // deliberately constructed statements to review (CONTRIBUTING.md).
    function sqlShape(node) {
      const expression = unwrapExpression(node);
      if (expression.type === 'Literal') {
        return typeof expression.value === 'string'
          ? expression.value
          : unknownPart;
      }
      if (expression.type === 'TemplateLiteral') {
        return expression.quasis
          .map(
            (part, index) =>
              (part.value.cooked ?? part.value.raw) +
              (index < expression.expressions.length
                ? sqlShape(expression.expressions[index])
                : ''),
          )
          .join('');
      }
      if (
        expression.type === 'BinaryExpression' &&
        expression.operator === '+'
      ) {
        return sqlShape(expression.left) + sqlShape(expression.right);
      }
      return unknownPart;
    }
    function isDirectNamedExport(node) {
      const exportNode = node.parent;
      return (
        exportNode?.type === 'ExportNamedDeclaration' &&
        exportNode.declaration === node &&
        exportNode.parent?.type === 'Program'
      );
    }
    function matchesMethodOwner(method) {
      if (method.computed || method.static || method.kind !== 'method') {
        return false;
      }
      const classBody = method.parent;
      const classNode =
        classBody?.type === 'ClassBody' ? classBody.parent : undefined;
      if (
        classNode?.type !== 'ClassDeclaration' ||
        !isDirectNamedExport(classNode)
      ) {
        return false;
      }
      const className = identifierName(classNode.id);
      const methodName = identifierName(method.key);
      return owners.has(`${className}.${methodName}`);
    }
    function matchesFunctionOwner(fn) {
      if (!fn.id || !isDirectNamedExport(fn)) return false;
      const functionName = identifierName(fn.id);
      return owners.has(functionName);
    }
    function isTransparentCallable(callable) {
      const parent = callable.parent;
      if (
        callable.type === 'FunctionExpression' &&
        parent?.type === 'MethodDefinition' &&
        parent.value === callable
      ) {
        return true;
      }
      return (
        (callable.type === 'ArrowFunctionExpression' ||
          (callable.type === 'FunctionExpression' && !callable.id)) &&
        parent?.type === 'CallExpression' &&
        parent.arguments[0] === callable &&
        memberName(parent.callee) === 'transaction'
      );
    }
    function inspect(node) {
      // Inspect the outer concatenation/template once, including TS wrappers.
      let child = node;
      let parent = node.parent;
      while (
        parent?.expression === child &&
        unwrapExpression(parent) !== parent
      ) {
        child = parent;
        parent = parent.parent;
      }
      if (
        parent?.type === 'TemplateLiteral' ||
        (parent?.type === 'BinaryExpression' && parent.operator === '+')
      ) {
        return;
      }
      let hasUnknownCommentEnd = false;
      const sql = sqlShape(node).replace(commentsOrQuotes, (part) => {
        if (!part.startsWith('/*') && !part.startsWith('--')) return part;
        if (
          part.startsWith('/*') &&
          !part.endsWith('*/') &&
          part.includes(unknownPart)
        ) {
          hasUnknownCommentEnd = true;
        }
        // Unknown comment content can end the comment and change the target.
        return part.includes(unknownPart) ? ` ${unknownPart} ` : ' ';
      });
      // Generic dynamic-target checks must not treat prose such as "Failed to
      // update ${name}" as SQL. Literal protected-table detection stays broader.
      const startsWithSql = sqliteStatementStart.test(sql);
      // A dynamically closed block comment can conceal the remaining header.
      if (startsWithSql && hasUnknownCommentEnd) {
        context.report({ node, messageId: 'dynamicTarget' });
        return;
      }
      let writesContainerSpec = false;
      for (const match of sql.matchAll(writeTargets)) {
        const first = match[1];
        if (first === undefined) continue;
        const table = match[2] ?? first;
        if (match[0].includes(unknownPart)) {
          if (!startsWithSql) continue;
          context.report({ node, messageId: 'dynamicTarget' });
          return;
        }
        const name = /^["'`[]/u.test(table) ? table.slice(1, -1) : table;
        if (name.toLowerCase() === 'container_specs')
          writesContainerSpec = true;
      }
      if (!writesContainerSpec) return;
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent.type === 'MethodDefinition') {
          if (matchesMethodOwner(parent)) return;
          break;
        }
        if (parent.type === 'FunctionDeclaration') {
          if (matchesFunctionOwner(parent)) return;
          break;
        }
        if (
          parent.type === 'ArrowFunctionExpression' ||
          parent.type === 'FunctionExpression'
        ) {
          if (isTransparentCallable(parent)) continue;
          break;
        }
      }
      context.report({ node, messageId: 'owner' });
    }
    return {
      Literal(node) {
        if (typeof node.value === 'string') inspect(node);
      },
      TemplateLiteral: inspect,
      BinaryExpression(node) {
        if (node.operator === '+') inspect(node);
      },
    };
  },
};

const workloadAdmissionWriteOwnership = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Keep workload-creation writes inside the admission persistence stage.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowedFiles: {
            type: 'array',
            items: { type: 'string' },
            uniqueItems: true,
          },
        },
        required: ['allowedFiles'],
        additionalProperties: false,
      },
    ],
    messages: {
      owner:
        '{{method}} is a workload-admission write and may only be called by the persistence stage.',
    },
  },
  create(context) {
    if (isAllowedOwner(context)) return {};
    const protectedMethods = new Set([
      'upsertCredential',
      'createWorkload',
      'createTargetedWorkload',
    ]);
    const repositoryGetters = new Set();
    const repositoryVariables = new Set();

    function variableIsIn(variableSet, identifier) {
      const variable = resolvedVariable(context, identifier);
      return variable !== undefined && variableSet.has(variable);
    }

    function addVariable(variableSet, identifier) {
      const variable = resolvedVariable(context, identifier);
      if (variable) variableSet.add(variable);
    }

    function sourceEndsWith(source, moduleName) {
      const path = localModulePath(source);
      return path !== undefined && path.endsWith(`/${moduleName}`);
    }

    function isRepositoryCapability(node) {
      const expression = unwrapExpression(node);
      if (!expression) return false;
      if (expression.type === 'Identifier') {
        return variableIsIn(repositoryVariables, expression);
      }
      return (
        expression.type === 'CallExpression' &&
        expression.callee.type === 'Identifier' &&
        variableIsIn(repositoryGetters, expression.callee)
      );
    }

    function report(node, method) {
      context.report({
        node,
        messageId: 'owner',
        data: { method },
      });
    }

    function inspectPattern(pattern, source) {
      if (pattern.type !== 'ObjectPattern' || !isRepositoryCapability(source)) {
        return;
      }
      for (const property of pattern.properties) {
        if (property.type !== 'Property') continue;
        const method = property.computed
          ? literalModuleSpecifier(property.key)
          : identifierName(property.key);
        if (method && protectedMethods.has(method)) report(property, method);
      }
    }

    return {
      ImportDeclaration(node) {
        if (typeof node.source.value !== 'string') return;
        const importsWriter = sourceEndsWith(
          node.source.value,
          'workload-admission-writer.js',
        );
        for (const specifier of node.specifiers) {
          if (
            specifier.type !== 'ImportSpecifier' ||
            !isValueImport(node, specifier)
          ) {
            continue;
          }
          if (
            importsWriter &&
            importedName(specifier) === 'getWorkloadAdmissionWriter'
          ) {
            addVariable(repositoryGetters, specifier.local);
          }
        }
      },
      VariableDeclarator(node) {
        if (!node.init) return;
        if (
          node.id.type === 'Identifier' &&
          isRepositoryCapability(node.init)
        ) {
          addVariable(repositoryVariables, node.id);
        } else {
          inspectPattern(node.id, node.init);
        }
      },
      AssignmentExpression(node) {
        if (node.operator !== '=') return;
        if (
          node.left.type === 'Identifier' &&
          isRepositoryCapability(node.right)
        ) {
          addVariable(repositoryVariables, node.left);
        } else {
          inspectPattern(node.left, node.right);
        }
      },
      MemberExpression(node) {
        const method = memberName(node);
        if (
          method &&
          protectedMethods.has(method) &&
          isRepositoryCapability(node.object)
        ) {
          report(node, method);
        }
      },
      CallExpression(node) {
        if (
          node.callee.type !== 'MemberExpression' ||
          identifierName(node.callee.object) !== 'Reflect' ||
          memberName(node.callee) !== 'get'
        ) {
          return;
        }
        const method = literalModuleSpecifier(node.arguments[1]);
        if (
          method &&
          protectedMethods.has(method) &&
          isRepositoryCapability(node.arguments[0])
        ) {
          report(node, method);
        }
      },
    };
  },
};

function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (current.type === 'ChainExpression' ||
      current.type === 'TSAsExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSTypeAssertion')
  ) {
    current = current.expression;
  }
  return current;
}

// Cloudflare R2 speaks S3, so its client factory is audited with the AWS SDK,
// limited to the S3 client.
const API_PROVIDER_FACTORY_FILES = {
  aws: [
    { file: 'src/api/services/provider-clients/aws.ts' },
    {
      file: 'src/api/services/provider-clients/cloudflare.ts',
      names: new Set(['S3Client']),
    },
  ],
  azure: [{ file: 'src/api/services/provider-clients/azure.ts' }],
  gcp: [{ file: 'src/api/services/provider-clients/gcp.ts' }],
};

const API_PROVIDER_FACTORY_IMPORTS = new Map([
  [
    '@aws-sdk/client-account',
    { provider: 'aws', names: new Set(['Account', 'AccountClient']) },
  ],
  [
    '@aws-sdk/client-cost-explorer',
    {
      provider: 'aws',
      names: new Set(['CostExplorer', 'CostExplorerClient']),
    },
  ],
  [
    '@aws-sdk/client-cloudformation',
    { provider: 'aws', names: new Set(['CloudFormationClient']) },
  ],
  [
    '@aws-sdk/client-ec2',
    { provider: 'aws', names: new Set(['EC2', 'EC2Client']) },
  ],
  [
    '@aws-sdk/client-iam',
    { provider: 'aws', names: new Set(['IAM', 'IAMClient']) },
  ],
  [
    '@aws-sdk/client-s3',
    { provider: 'aws', names: new Set(['S3', 'S3Client']) },
  ],
  [
    '@aws-sdk/client-service-quotas',
    {
      provider: 'aws',
      names: new Set(['ServiceQuotas', 'ServiceQuotasClient']),
    },
  ],
  [
    '@aws-sdk/client-sts',
    {
      provider: 'aws',
      // An unsigned exchange of the API's ServiceAccount token for a saved
      // role connection's session (RFC 0047 amendment 8).
      names: new Set(['STS', 'STSClient', 'AssumeRoleWithWebIdentityCommand']),
    },
  ],
  [
    '@azure/arm-compute',
    { provider: 'azure', names: new Set(['ComputeManagementClient']) },
  ],
  [
    '@azure/arm-costmanagement',
    { provider: 'azure', names: new Set(['CostManagementClient']) },
  ],
  [
    '@azure/arm-network',
    { provider: 'azure', names: new Set(['NetworkManagementClient']) },
  ],
  [
    '@azure/arm-quota',
    { provider: 'azure', names: new Set(['AzureQuotaExtensionAPI']) },
  ],
  [
    '@azure/arm-resources',
    { provider: 'azure', names: new Set(['ResourceManagementClient']) },
  ],
  [
    '@azure/arm-storage',
    { provider: 'azure', names: new Set(['StorageManagementClient']) },
  ],
  [
    '@azure/arm-support',
    { provider: 'azure', names: new Set(['MicrosoftSupport']) },
  ],
  [
    '@azure/storage-blob',
    {
      provider: 'azure',
      names: new Set([
        'BlobServiceClient',
        'ContainerSASPermissions',
        'generateBlobSASQueryParameters',
        'SASProtocol',
        'StorageSharedKeyCredential',
      ]),
    },
  ],
  ['@google-cloud/bigquery', { provider: 'gcp', names: new Set(['BigQuery']) }],
  [
    '@google-cloud/compute',
    {
      provider: 'gcp',
      names: new Set([
        'DisksClient',
        'FirewallsClient',
        'GlobalOperationsClient',
        'ImagesClient',
        'InstancesClient',
        'MachineTypesClient',
        'NetworksClient',
        'ZoneOperationsClient',
      ]),
    },
  ],
  ['@google-cloud/storage', { provider: 'gcp', names: new Set(['Storage']) }],
]);

const API_PROVIDER_CALLSITE_IMPORTS = new Map([
  [
    '@aws-sdk/client-ec2',
    new Set([
      'InstanceInterruptionBehavior',
      'MarketType',
      'SpotInstanceType',
      'VolumeType',
    ]),
  ],
  ['@aws-sdk/client-s3', new Set(['waitUntilBucketExists'])],
  ['@aws-sdk/lib-storage', new Set(['Upload'])],
  ['@aws-sdk/util-waiter', new Set(['createWaiter', 'WaiterState'])],
  // A bare request for an audited client's own pipeline, which authenticates
  // it; used to follow Cost Management nextLink pages.
  ['@azure/core-rest-pipeline', new Set(['createPipelineRequest'])],
]);

const GCP_AMBIENT_AUTH_PACKAGES = new Set([
  '@google-cloud/local-auth',
  'gcp-metadata',
  'google-auth-library',
  'google-gax',
  'googleapis',
  'googleapis-common',
]);

// A JWT signed with the selected stored key, and the client that exchanges
// its token for a bucket-downscoped one (RFC 0047): no ambient lookup. A
// saved role connection's client takes its subject token from a supplier the
// factory passes (amendment 9), never from a file or URL.
const GCP_EXPLICIT_KEY_AUTH = new Set([
  // The management VM's attached service account, for the hosted API's
  // backups only (RFC 0049 C26 (e), owner question 10).
  'Compute',
  'DownscopedClient',
  'IdentityPoolClient',
  'JWT',
]);

function isPackageOrSubpath(source, packageName) {
  return source === packageName || source.startsWith(`${packageName}/`);
}

function isGcpAmbientAuthSource(source) {
  for (const packageName of GCP_AMBIENT_AUTH_PACKAGES) {
    if (isPackageOrSubpath(source, packageName)) return true;
  }
  return false;
}

function providerForSdkSource(source) {
  if (source.startsWith('@aws-sdk/') || source.startsWith('@smithy/')) {
    return 'aws';
  }
  if (source.startsWith('@azure/')) return 'azure';
  if (source.startsWith('@google-cloud/') || isGcpAmbientAuthSource(source)) {
    return 'gcp';
  }
  return undefined;
}

function isDefaultCredentialSource(source) {
  return (
    source.startsWith('@aws-sdk/credential-') ||
    source.startsWith('@smithy/credential-provider-') ||
    isGcpAmbientAuthSource(source)
  );
}

function isAllowedProviderCallsiteImport(source, name) {
  return (
    (source.startsWith('@aws-sdk/client-') && name.endsWith('Command')) ||
    API_PROVIDER_CALLSITE_IMPORTS.get(source)?.has(name) === true
  );
}

const explicitApiProviderCredentials = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require API provider clients to use an explicitly selected stored credential.',
    },
    schema: [],
    messages: {
      defaultChain:
        'API provider access must use a selected stored credential; default, ambient, and local operator credential chains are forbidden.',
      factoryOnly:
        '{{constructor}} is credential-bearing and may only be imported by the audited {{provider}} provider-client factory.',
      namedImports:
        'Provider SDK namespaces and default exports are not audited. Import types or explicitly allowlisted named runtime exports instead.',
      sideEffectImport:
        'Provider SDK side-effect import {{source}} is not allowed in API code.',
      factoryAllowlist:
        '{{name}} is not an allowlisted constructor import for the audited {{provider}} provider-client factory.',
      runtimeImport:
        '{{name}} from {{source}} is not an allowlisted {{provider}} provider SDK runtime import. Use a type import, an approved command or helper, or the audited provider-client factory.',
    },
  },
  create(context) {
    const filename = normalizedFilename(context);
    const cwd = contextCwd(context);
    const factoryEntry = Object.entries(API_PROVIDER_FACTORY_FILES)
      .flatMap(([provider, entries]) =>
        entries.map((entry) => ({ provider, ...entry })),
      )
      .find(({ file }) => filename === normalizedAbsolutePath(file, cwd));
    const factoryProvider = factoryEntry?.provider;
    function isFactoryOwner(provider) {
      return factoryProvider === provider;
    }

    function rejectDefaultCredentialImport(node) {
      const source = node.source.value;
      if (typeof source !== 'string' || node.importKind === 'type') {
        return false;
      }
      const valueSpecifiers = node.specifiers.filter((specifier) =>
        isValueImport(node, specifier),
      );
      if (
        source === 'google-auth-library' &&
        isFactoryOwner('gcp') &&
        node.specifiers.length > 0
      ) {
        for (const specifier of valueSpecifiers) {
          if (
            specifier.type !== 'ImportSpecifier' ||
            !GCP_EXPLICIT_KEY_AUTH.has(importedName(specifier))
          ) {
            context.report({ node: specifier, messageId: 'defaultChain' });
          }
        }
        return true;
      }
      if (isDefaultCredentialSource(source)) {
        if (node.specifiers.length === 0 || valueSpecifiers.length > 0) {
          context.report({ node: node.source, messageId: 'defaultChain' });
        }
        return true;
      }
      if (source !== '@azure/identity') return false;
      if (node.specifiers.length === 0) {
        context.report({ node: node.source, messageId: 'defaultChain' });
      }
      for (const specifier of node.specifiers) {
        if (
          specifier.importKind === 'type' ||
          (specifier.type === 'ImportSpecifier' &&
            // A saved key, a saved role connection's assertion, and the
            // errors their token requests raise.
            [
              'ClientSecretCredential',
              'ClientAssertionCredential',
              // The management VM's identity, for the hosted API's backups
              // and its self-delete only (RFC 0049 C26 (e), seed design).
              'ManagedIdentityCredential',
              'AuthenticationError',
              'AuthenticationRequiredError',
            ].includes(importedName(specifier)) &&
            isFactoryOwner('azure'))
        ) {
          continue;
        }
        context.report({ node: specifier, messageId: 'defaultChain' });
      }
      return true;
    }

    function enforceProviderImports(node) {
      const source = node.source.value;
      if (typeof source !== 'string') return;
      const sourceProvider = providerForSdkSource(source);
      if (!sourceProvider) return;
      const policy = API_PROVIDER_FACTORY_IMPORTS.get(source);
      if (node.specifiers.length === 0) {
        context.report({
          node: node.source,
          messageId: 'sideEffectImport',
          data: { source },
        });
        return;
      }
      for (const specifier of node.specifiers) {
        if (!isValueImport(node, specifier)) continue;
        if (specifier.type !== 'ImportSpecifier') {
          context.report({ node: specifier, messageId: 'namedImports' });
          continue;
        }
        const name = importedName(specifier);
        if (!name) continue;
        if (factoryProvider === sourceProvider) {
          if (
            policy?.names.has(name) &&
            (!factoryEntry.names || factoryEntry.names.has(name))
          ) {
            continue;
          }
          context.report({
            node: specifier,
            messageId: 'factoryAllowlist',
            data: { name, provider: factoryProvider },
          });
          continue;
        }
        if (policy?.names.has(name)) {
          context.report({
            node: specifier,
            messageId: 'factoryOnly',
            data: { constructor: name, provider: policy.provider },
          });
          continue;
        }
        if (!isAllowedProviderCallsiteImport(source, name)) {
          context.report({
            node: specifier,
            messageId: 'runtimeImport',
            data: { name, provider: sourceProvider, source },
          });
        }
      }
    }

    return {
      ImportDeclaration(node) {
        if (!rejectDefaultCredentialImport(node)) {
          enforceProviderImports(node);
        }
      },
    };
  },
};

const apiContractBuilderOwnership = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Keep the low-level oRPC route and metadata builders in their configured owner file.',
    },
    schema: ownershipRuleSchema,
    messages: {
      builder:
        'Low-level contract .{{method}}() calls belong in the configured API contract builder owner.',
      ocExport:
        'Do not export or re-export the low-level oRPC `oc` builder from its owner.',
      ocImport:
        'Import the low-level oRPC `oc` builder only in the configured API contract builder owner.',
    },
  },
  create(context) {
    const isOwner = isAllowedOwner(context);
    const checkBuilderCalls = context.options[0]?.checkBuilderCalls ?? true;
    const ocBindings = new Set();
    const contractNamespaces = new Set();

    function isOcReference(value) {
      const node = unwrapExpression(value);
      if (!node) return false;
      if (node.type === 'Identifier') return ocBindings.has(node.name);
      return (
        node.type === 'MemberExpression' &&
        memberName(node) === 'oc' &&
        node.object.type === 'Identifier' &&
        contractNamespaces.has(node.object.name)
      );
    }

    return {
      ImportDeclaration(node) {
        for (const specifier of node.specifiers) {
          if (!isValueImport(node, specifier)) continue;
          if (
            node.source.value === '@orpc/contract' &&
            specifier.type === 'ImportNamespaceSpecifier'
          ) {
            contractNamespaces.add(specifier.local.name);
            if (!isOwner) {
              context.report({ node: specifier, messageId: 'ocImport' });
            }
          } else if (importedName(specifier) === 'oc') {
            ocBindings.add(specifier.local.name);
            if (!isOwner) {
              context.report({ node: specifier, messageId: 'ocImport' });
            }
          }
        }
      },
      VariableDeclarator(node) {
        if (
          node.id.type === 'Identifier' &&
          node.init &&
          isOcReference(node.init)
        ) {
          ocBindings.add(node.id.name);
        }
      },
      AssignmentExpression(node) {
        if (node.left.type === 'Identifier' && isOcReference(node.right)) {
          ocBindings.add(node.left.name);
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source) {
          for (const specifier of node.specifiers) {
            if (
              !isTypeOnlyExport(node, specifier) &&
              specifier.type === 'ExportSpecifier' &&
              (identifierName(specifier.local) === 'oc' ||
                identifierName(specifier.exported) === 'oc')
            ) {
              context.report({ node: specifier, messageId: 'ocExport' });
            }
          }
          return;
        }
        for (const specifier of node.specifiers) {
          if (
            !isTypeOnlyExport(node, specifier) &&
            specifier.type === 'ExportSpecifier' &&
            specifier.local.type === 'Identifier' &&
            (ocBindings.has(specifier.local.name) ||
              contractNamespaces.has(specifier.local.name))
          ) {
            context.report({ node: specifier, messageId: 'ocExport' });
          }
        }
        if (node.declaration?.type === 'VariableDeclaration') {
          for (const declaration of node.declaration.declarations) {
            if (declaration.init && isOcReference(declaration.init)) {
              context.report({ node: declaration, messageId: 'ocExport' });
            }
          }
        }
      },
      ExportDefaultDeclaration(node) {
        if (isOcReference(node.declaration)) {
          context.report({ node, messageId: 'ocExport' });
        }
      },
      ExportAllDeclaration(node) {
        if (
          node.exportKind !== 'type' &&
          node.source.value === '@orpc/contract'
        ) {
          context.report({ node, messageId: 'ocExport' });
        }
      },
      CallExpression(node) {
        if (!checkBuilderCalls || isOwner) return;
        const callee = unwrapExpression(node.callee);
        if (callee?.type !== 'MemberExpression') return;
        const method = memberName(callee);
        if (method === 'route' || method === 'meta') {
          context.report({
            node: callee,
            messageId: 'builder',
            data: { method },
          });
        }
      },
    };
  },
};

function destructuredPropertyName(property) {
  if (property.type !== 'Property') return undefined;
  if (!property.computed && property.key.type === 'Identifier') {
    return property.key.name;
  }
  if (property.computed && property.key.type === 'Literal') {
    return typeof property.key.value === 'string'
      ? property.key.value
      : undefined;
  }
  return undefined;
}

const apiContractInspectionOwnership = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Keep oRPC contract resolution and internal policy inspection in their configured owner file.',
    },
    schema: ownershipRuleSchema,
    messages: {
      resolver:
        'getContractRouter inspection belongs in the configured API contract inspection owner.',
      internals:
        'Direct oRPC policy/error metadata inspection belongs in the configured API contract inspection owner.',
    },
  },
  create(context) {
    if (isAllowedOwner(context)) return {};

    const contractNamespaces = new Set();

    function isContractNamespace(value) {
      const node = unwrapExpression(value);
      return node?.type === 'Identifier' && contractNamespaces.has(node.name);
    }

    return {
      ImportDeclaration(node) {
        if (node.source.value !== '@orpc/contract') return;
        for (const specifier of node.specifiers) {
          if (!isValueImport(node, specifier)) continue;
          if (specifier.type === 'ImportNamespaceSpecifier') {
            contractNamespaces.add(specifier.local.name);
          } else if (importedName(specifier) === 'getContractRouter') {
            context.report({ node: specifier, messageId: 'resolver' });
          }
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source?.value !== '@orpc/contract') return;
        for (const specifier of node.specifiers) {
          if (
            specifier.type === 'ExportSpecifier' &&
            identifierName(specifier.local) === 'getContractRouter'
          ) {
            context.report({ node: specifier, messageId: 'resolver' });
          }
        }
      },
      VariableDeclarator(node) {
        if (!node.init || !isContractNamespace(node.init)) return;
        if (node.id.type === 'Identifier') {
          contractNamespaces.add(node.id.name);
          return;
        }
        if (node.id.type !== 'ObjectPattern') return;
        for (const property of node.id.properties) {
          if (destructuredPropertyName(property) === 'getContractRouter') {
            context.report({ node: property, messageId: 'resolver' });
          }
        }
      },
      AssignmentExpression(node) {
        if (
          node.left.type === 'Identifier' &&
          isContractNamespace(node.right)
        ) {
          contractNamespaces.add(node.left.name);
        }
      },
      MemberExpression(node) {
        const property = memberName(node);
        if (property === '~orpc') {
          context.report({ node, messageId: 'internals' });
        } else if (
          property === 'getContractRouter' &&
          isContractNamespace(node.object)
        ) {
          context.report({ node, messageId: 'resolver' });
        }
      },
    };
  },
};

/**
 * `errorMessage()` exists and was documented as preferred while nine files
 * wrote their own copy of it, so advice alone did not hold this. See RFC 0023.
 */
const noHandRolledErrorMessage = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow re-implementing errorMessage() at a call site.',
    },
    schema: [],
    messages: {
      logMetadata:
        'The logger serializes and redacts `error` for you, so passing `.message` hands it a string and drops the name, code and stack. Pass the error itself.',
      handRolled:
        "Use errorMessage() from shared/log-diagnostics. This form returns '[object Object]' for a thrown value that is not an Error, losing everything it carried.",
    },
  },
  create(context) {
    // `x instanceof Error ? x.message : <anything>`, same `x` in both places.
    const handRolled = (node) => {
      const { test, consequent } = node;
      if (
        test.type !== 'BinaryExpression' ||
        test.operator !== 'instanceof' ||
        test.left.type !== 'Identifier' ||
        test.right.type !== 'Identifier' ||
        test.right.name !== 'Error'
      ) {
        return undefined;
      }
      if (
        consequent.type !== 'MemberExpression' ||
        consequent.property.type !== 'Identifier' ||
        consequent.property.name !== 'message' ||
        consequent.object.type !== 'Identifier' ||
        consequent.object.name !== test.left.name
      ) {
        return undefined;
      }
      return test.left.name;
    };

    return {
      ConditionalExpression(node) {
        if (!handRolled(node)) return;
        // "Pass the error itself" holds only where a logger receives it. A
        // property named `error` is not enough: a JSON response body and a
        // string-typed field both take one, and neither serializes an Error.
        const property = node.parent;
        const object = property?.parent;
        const call = object?.parent;
        const callee =
          call?.type === 'CallExpression' ? call.callee : undefined;
        const method =
          callee?.type === 'MemberExpression' &&
          callee.property.type === 'Identifier'
            ? callee.property.name
            : undefined;
        const receiver =
          callee?.type === 'MemberExpression' &&
          callee.object.type === 'Identifier'
            ? callee.object.name
            : undefined;
        const inLogErrorField =
          property?.type === 'Property' &&
          property.key.type === 'Identifier' &&
          property.key.name === 'error' &&
          object?.type === 'ObjectExpression' &&
          (receiver === 'log' ||
            receiver === 'logger' ||
            (method !== undefined && /^log[A-Z]/.test(method)));
        context.report({
          node,
          messageId: inLogErrorField ? 'logMetadata' : 'handRolled',
        });
      },
    };
  },
};

/**
 * An Error's own fields are not enumerable, so persisting one records `{}` and
 * the reason is lost. Production callers are stopped by the type on the event
 * metadata; this catches the other half, where a test asserts the shape that
 * never survives being written. See RFC 0023.
 */
const noRawErrorInPersistedMetadata = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a raw Error inside persisted workload event metadata.',
    },
    schema: [],
    messages: {
      rawError:
        "An Error's own fields are not enumerable, so this is stored as `{}` and the reason is lost. Serialize it (errorForDiagnosticMetadata), and assert what was written with latestEventMetadata() rather than the argument passed to a spy.",
    },
  },
  create(context) {
    const constructsError = (node) =>
      node?.type === 'NewExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name.endsWith('Error');

    const isRawErrorValue = (value) => {
      if (constructsError(value)) return true;
      if (value.type !== 'Identifier') return false;
      // Resolve the binding rather than trusting its name: a variable called
      // `error` frequently holds an already-serialized value, and flagging
      // those is how a rule earns a blanket disable.
      const scope = context.sourceCode.getScope(value);
      const variable = scope.references.find(
        (reference) => reference.identifier === value,
      )?.resolved;
      if (!variable || variable.defs.length !== 1) return false;
      return constructsError(variable.defs[0].node?.init);
    };

    return {
      Property(node) {
        if (node.key.type !== 'Identifier' || node.key.name !== 'metadata') {
          return;
        }
        if (node.value.type !== 'ObjectExpression') return;
        for (const inner of node.value.properties) {
          if (inner.type !== 'Property') continue;
          if (inner.key.type !== 'Identifier' || inner.key.name !== 'error') {
            continue;
          }
          if (isRawErrorValue(inner.value)) {
            context.report({ node: inner, messageId: 'rawError' });
          }
        }
      },
    };
  },
};

/**
 * Every statement writing workload_events.metadata must build that column
 * with eventMetadataColumn(), which redacts and stringifies in one place.
 *
 * Two writers once stored caller-supplied data unredacted, and the second
 * survived review because the check matched the shape the others used rather
 * than enumerating the writers. A rule keyed on the table name cannot make that
 * mistake: it sees every statement that names it.
 */
const workloadEventMetadataOwnership = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require workload_events metadata to be built by eventMetadataColumn().',
    },
    schema: [],
    messages: {
      unowned:
        'Build the workload_events metadata column with eventMetadataColumn(), so redaction stays in one place rather than at every writer.',
    },
  },
  create(context) {
    const WRITES_EVENTS = /(INSERT\s+INTO|UPDATE)\s+workload_events/i;

    /** The raw text of a string or template literal argument. */
    const literalText = (node) => {
      if (node.type === 'TemplateLiteral') {
        return node.quasis.map((quasi) => quasi.value.raw).join(' ');
      }
      if (node.type === 'Literal' && typeof node.value === 'string') {
        return node.value;
      }
      return undefined;
    };

    const bindsMetadata = (sql) =>
      // A patch that sets a literal marker binds no value, so there is nothing
      // for the helper to redact.
      /metadata/i.test(sql) && /\?/.test(sql.replace(/WHERE[\s\S]*$/i, ''));

    const buildsColumn = (node) => {
      let found = false;
      const walk = (value) => {
        if (found || !value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
          value.forEach(walk);
          return;
        }
        if (
          value.type === 'CallExpression' &&
          value.callee.type === 'Identifier' &&
          value.callee.name === 'eventMetadataColumn'
        ) {
          found = true;
          return;
        }
        for (const key of Object.keys(value)) {
          if (key === 'parent') continue;
          walk(value[key]);
        }
      };
      walk(node);
      return found;
    };

    return {
      CallExpression(node) {
        const sqlArg = node.arguments.find((argument) => {
          const text = literalText(argument);
          return text !== undefined && WRITES_EVENTS.test(text);
        });
        if (!sqlArg) return;
        if (!bindsMetadata(literalText(sqlArg))) return;
        if (buildsColumn(node.arguments)) return;
        context.report({ node: sqlArg, messageId: 'unowned' });
      },
    };
  },
};

const noSkippedOrFocusedTests = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow skipped or focused tests in committed code.',
    },
    schema: [],
    messages: {
      only: 'Test isolation with .only() is not allowed in committed code. Remove before committing.',
      skip: 'Test skipping is not allowed. Tests must either run or fail explicitly with proper error messages.',
      skipIf:
        'Test skipping is not allowed. Use beforeAll() to throw an error if conditions are not met.',
      runIf:
        'Conditional test execution is not allowed. Run the test or fail its prerequisites.',
      todo: 'Placeholder tests are not allowed. Every registered test must execute assertions.',
      conditionalDefinition:
        'Do not register tests conditionally. Declare the test and fail explicitly if its prerequisites are unavailable.',
    },
  },
  create(context) {
    const testNames = new Set(['it', 'test']);
    const suiteNames = new Set(['describe', 'suite']);
    const forbidden = new Set(['skip', 'skipIf', 'runIf', 'todo', 'only']);
    const disabledNames = new Set(['xit', 'xtest', 'xdescribe']);
    const testCallbacks = new Set();
    const testOptions = new Set();
    const rootName = (node) => {
      if (node?.type === 'CallExpression') return rootName(node.callee);
      if (node?.type === 'MemberExpression') return rootName(node.object);
      if (node?.type === 'TaggedTemplateExpression') return rootName(node.tag);
      return node?.name;
    };
    return {
      ImportSpecifier(node) {
        const imported = node.imported.name;
        if (['it', 'test'].includes(imported)) testNames.add(node.local.name);
        if (['describe', 'suite'].includes(imported))
          suiteNames.add(node.local.name);
        if (disabledNames.has(imported)) disabledNames.add(node.local.name);
      },
      CallExpression(node) {
        const name = memberName(node.callee);
        if (forbidden.has(name)) {
          context.report({ node: node.callee, messageId: name });
        }
        if (disabledNames.has(rootName(node.callee)))
          context.report({ node: node.callee, messageId: 'skip' });
        if (
          testNames.has(rootName(node.callee)) ||
          suiteNames.has(rootName(node.callee))
        ) {
          for (const argument of node.arguments) {
            if (argument.type === 'ObjectExpression') testOptions.add(argument);
          }
          let owner = node.parent;
          while (
            owner &&
            ![
              'FunctionDeclaration',
              'FunctionExpression',
              'ArrowFunctionExpression',
            ].includes(owner.type)
          ) {
            if (
              [
                'IfStatement',
                'ConditionalExpression',
                'LogicalExpression',
              ].includes(owner.type)
            ) {
              context.report({ node, messageId: 'conditionalDefinition' });
              break;
            }
            owner = owner.parent;
          }
        }
        if (testNames.has(rootName(node.callee))) {
          for (const argument of node.arguments) {
            if (
              ['FunctionExpression', 'ArrowFunctionExpression'].includes(
                argument.type,
              )
            )
              testCallbacks.add(argument);
          }
          if (
            !forbidden.has(name) &&
            node.arguments.length === 1 &&
            typeof node.arguments[0].value === 'string'
          )
            context.report({ node, messageId: 'todo' });
        }
      },
      Property(node) {
        const name =
          node.key.type === 'Literal'
            ? node.key.value
            : !node.computed
              ? node.key.name
              : undefined;
        if (!forbidden.has(name)) return;
        if (testOptions.has(node.parent))
          context.report({ node, messageId: name });
        if (node.parent.type !== 'ObjectPattern') return;
        const declaration = node.parent.parent;
        let owner = declaration;
        while (
          owner &&
          ![
            'FunctionDeclaration',
            'FunctionExpression',
            'ArrowFunctionExpression',
          ].includes(owner.type)
        )
          owner = owner.parent;
        if (
          testCallbacks.has(owner) ||
          (declaration.type === 'VariableDeclarator' &&
            (testNames.has(rootName(declaration.init)) ||
              suiteNames.has(rootName(declaration.init))))
        )
          context.report({ node, messageId: name });
      },
      MemberExpression(node) {
        if (
          node.parent.type === 'CallExpression' &&
          node.parent.callee === node
        ) {
          return;
        }
        if (
          forbidden.has(memberName(node)) &&
          (suiteNames.has(rootName(node.object)) ||
            testNames.has(rootName(node.object)))
        ) {
          context.report({ node, messageId: memberName(node) });
        }
      },
    };
  },
};

function referencedTypeName(typeAnnotation) {
  if (
    typeAnnotation.type === 'TSTypeReference' &&
    typeAnnotation.typeName.type === 'Identifier'
  ) {
    return typeAnnotation.typeName.name;
  }
  return undefined;
}

const noUnsafeTypeAssertions = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow assertion patterns that bypass repository type-safety conventions.',
    },
    schema: [],
    messages: {
      workloadState:
        'Use WorkloadState.X enum value instead of casting a string literal. Raw strings bypass enum case guarantees.',
      launderedObject:
        'Casting an object literal through `unknown` or `any` bypasses shape checking entirely. Declare `const x: T = {...}` or use a typed fixture builder.',
      mock: 'Use vi.mocked(thing) instead of (thing as Mock). It is type-safe and matches the modern repo style (see credentials-*.spec.ts).',
    },
  },
  create(context) {
    return {
      TSAsExpression(node) {
        const typeName = referencedTypeName(node.typeAnnotation);
        // A nested assertion is transparent: `({...} as const) as unknown`
        // launders the same object literal one layer deeper.
        const expression = unwrapExpression(node.expression);
        if (expression.type === 'Literal' && typeName === 'WorkloadState') {
          context.report({ node, messageId: 'workloadState' });
          return;
        }
        if (typeName === 'Mock') {
          context.report({ node, messageId: 'mock' });
          return;
        }
        // consistent-type-assertions polices object-literal casts to real
        // types but exempts `unknown`/`any` — the exact escape hatch of
        // `{...} as unknown as T`.
        if (
          expression.type === 'ObjectExpression' &&
          (node.typeAnnotation.type === 'TSUnknownKeyword' ||
            node.typeAnnotation.type === 'TSAnyKeyword')
        ) {
          context.report({ node, messageId: 'launderedObject' });
        }
      },
    };
  },
};

function isDirectProcessObject(node) {
  const expression = unwrapExpression(node);
  return (
    identifierName(expression) === 'process' ||
    (expression?.type === 'MemberExpression' &&
      (identifierName(expression.object) === 'globalThis' ||
        identifierName(expression.object) === 'global') &&
      memberName(expression) === 'process')
  );
}

function isProcessEnvObject(node) {
  const expression = unwrapExpression(node);
  return (
    (expression?.type === 'MemberExpression' &&
      isDirectProcessObject(expression.object) &&
      memberName(expression) === 'env') ||
    (expression?.type === 'CallExpression' &&
      expression.callee.type === 'MemberExpression' &&
      identifierName(expression.callee.object) === 'Reflect' &&
      memberName(expression.callee) === 'get' &&
      isDirectProcessObject(expression.arguments[0]) &&
      literalModuleSpecifier(expression.arguments[1]) === 'env')
  );
}

function environmentAccessKey(node) {
  if (node.type !== 'MemberExpression' || !isProcessEnvObject(node.object)) {
    return undefined;
  }
  const name = memberName(node);
  if (name !== undefined) return { name, kind: 'variable' };
  // `process.env[X]` reads whatever X holds, which this cannot see. All it can
  // key on is X's spelling, so it is approved from a separate, weaker list
  // rather than sharing one namespace with real variable names.
  if (node.computed && node.property.type === 'Identifier') {
    return { name: node.property.name, kind: 'indirect' };
  }
  return { name: '<computed>', kind: 'computed' };
}

const TEST_MODE_PROPERTIES = new Set(['isTest', 'isTestMode', 'testMode']);

const noTestModeInProviderRuntime = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Keep provider construction and availability independent from test mode.',
    },
    schema: [],
    messages: {
      testMode:
        'Provider runtime behavior must depend on provider capabilities, not test mode.',
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        const environmentKey = environmentAccessKey(node);
        if (
          environmentKey?.name === 'IS_TEST' ||
          TEST_MODE_PROPERTIES.has(memberName(node))
        ) {
          context.report({ node, messageId: 'testMode' });
        }
      },
      Property(node) {
        if (
          node.parent.type === 'ObjectPattern' &&
          TEST_MODE_PROPERTIES.has(destructuredPropertyName(node))
        ) {
          context.report({ node, messageId: 'testMode' });
        }
      },
    };
  },
};

const environmentAccessOwnershipSchema = [
  {
    type: 'object',
    properties: {
      ownerFiles: {
        type: 'array',
        items: { type: 'string' },
        uniqueItems: true,
      },
      exceptions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            /** Environment variable names, as written in `process.env.NAME`. */
            variables: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              uniqueItems: true,
            },
            /**
             * Constant identifiers used as `process.env[NAME]`. These approve a
             * spelling rather than a variable, so the file can reach whatever
             * that constant holds; prefer `variables` and a literal access.
             */
            indirectVariables: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              uniqueItems: true,
            },
          },
          required: ['file'],
          additionalProperties: false,
          anyOf: [
            { required: ['variables'] },
            { required: ['indirectVariables'] },
          ],
        },
      },
    },
    required: ['ownerFiles', 'exceptions'],
    additionalProperties: false,
  },
];

function environmentAccessPolicy(context) {
  const filename = normalizedFilename(context);
  const cwd = contextCwd(context);
  const options = context.options[0] ?? {};
  const isOwner = (options.ownerFiles ?? []).some(
    (ownerFile) => filename === normalizedAbsolutePath(ownerFile, cwd),
  );
  const exception = (options.exceptions ?? []).find(
    ({ file }) => filename === normalizedAbsolutePath(file, cwd),
  );
  return {
    isOwner,
    allowedVariables: new Set(exception?.variables ?? []),
    allowedIndirectVariables: new Set(exception?.indirectVariables ?? []),
  };
}

function environmentPropertyKey(node) {
  const name = memberName(node);
  if (name !== undefined) return { name, kind: 'variable' };
  if (node.computed && node.property.type === 'Identifier') {
    return { name: node.property.name, kind: 'indirect' };
  }
  return { name: '<computed>', kind: 'computed' };
}

function reflectPropertyKey(argument) {
  const expression = unwrapExpression(argument);
  if (expression?.type === 'Literal' && typeof expression.value === 'string') {
    return { name: expression.value, kind: 'variable' };
  }
  if (expression?.type === 'Identifier') {
    return { name: expression.name, kind: 'indirect' };
  }
  return { name: '<computed>', kind: 'computed' };
}

function environmentCapabilityTracker(context) {
  const processVariables = new Set();
  const environmentVariables = new Set();
  const reflectGetVariables = new Set();

  function variableIsIn(variableSet, identifier) {
    const variable = resolvedVariable(context, identifier);
    return variable !== undefined && variableSet.has(variable);
  }

  function addVariable(variableSet, identifier) {
    const variable = resolvedVariable(context, identifier);
    if (variable) variableSet.add(variable);
  }

  function isGlobalContainer(node) {
    const expression = unwrapExpression(node);
    return (
      isUnshadowedGlobal(context, expression, 'globalThis') ||
      isUnshadowedGlobal(context, expression, 'global')
    );
  }

  function isReflectContainer(node) {
    return isUnshadowedGlobal(context, unwrapExpression(node), 'Reflect');
  }

  function isReflectGetReference(node) {
    const expression = unwrapExpression(node);
    if (expression?.type === 'Identifier') {
      return variableIsIn(reflectGetVariables, expression);
    }
    if (
      expression?.type === 'MemberExpression' &&
      isReflectContainer(expression.object) &&
      memberName(expression) === 'get'
    ) {
      return true;
    }
    return (
      expression?.type === 'CallExpression' &&
      expression.callee.type === 'MemberExpression' &&
      memberName(expression.callee) === 'bind' &&
      isReflectGetReference(expression.callee.object)
    );
  }

  function reflectGetParts(node) {
    const expression = unwrapExpression(node);
    if (expression?.type !== 'CallExpression') return undefined;
    if (isReflectGetReference(expression.callee)) {
      return {
        object: expression.arguments[0],
        property: expression.arguments[1],
      };
    }
    if (expression.callee.type !== 'MemberExpression') return undefined;

    const invocation = memberName(expression.callee);
    if (
      invocation === 'call' &&
      isReflectGetReference(expression.callee.object)
    ) {
      return {
        object: expression.arguments[1],
        property: expression.arguments[2],
      };
    }
    if (
      invocation === 'apply' &&
      isReflectGetReference(expression.callee.object)
    ) {
      const argumentsArray = unwrapExpression(expression.arguments[1]);
      if (argumentsArray?.type !== 'ArrayExpression') return undefined;
      return {
        object: argumentsArray.elements[0],
        property: argumentsArray.elements[1],
      };
    }
    if (
      invocation === 'apply' &&
      isReflectContainer(expression.callee.object) &&
      isReflectGetReference(expression.arguments[0])
    ) {
      const argumentsArray = unwrapExpression(expression.arguments[2]);
      if (argumentsArray?.type !== 'ArrayExpression') return undefined;
      return {
        object: argumentsArray.elements[0],
        property: argumentsArray.elements[1],
      };
    }
    return undefined;
  }

  function isProcessObject(node) {
    const expression = unwrapExpression(node);
    if (!expression) return false;
    if (expression.type === 'Identifier') {
      return (
        isUnshadowedGlobal(context, expression, 'process') ||
        variableIsIn(processVariables, expression)
      );
    }
    if (
      expression.type === 'MemberExpression' &&
      isGlobalContainer(expression.object) &&
      memberName(expression) === 'process'
    ) {
      return true;
    }
    const reflected = reflectGetParts(expression);
    return (
      reflected !== undefined &&
      isGlobalContainer(reflected.object) &&
      reflectPropertyKey(reflected.property).name === 'process'
    );
  }

  function isEnvironmentObject(node) {
    const expression = unwrapExpression(node);
    if (!expression) return false;
    if (
      expression.type === 'Identifier' &&
      variableIsIn(environmentVariables, expression)
    ) {
      return true;
    }
    if (
      expression.type === 'MemberExpression' &&
      isProcessObject(expression.object) &&
      memberName(expression) === 'env'
    ) {
      return true;
    }
    const reflected = reflectGetParts(expression);
    return (
      reflected !== undefined &&
      isProcessObject(reflected.object) &&
      reflectPropertyKey(reflected.property).name === 'env'
    );
  }

  function environmentKey(node) {
    const expression = unwrapExpression(node);
    if (
      expression?.type === 'MemberExpression' &&
      isEnvironmentObject(expression.object)
    ) {
      return environmentPropertyKey(expression);
    }
    const reflected = reflectGetParts(expression);
    if (reflected && isEnvironmentObject(reflected.object)) {
      return reflectPropertyKey(reflected.property);
    }
    return undefined;
  }

  function processPropertyIsUnresolved(node) {
    const expression = unwrapExpression(node);
    if (
      expression?.type === 'MemberExpression' &&
      isProcessObject(expression.object)
    ) {
      return memberName(expression) === undefined;
    }
    const reflected = reflectGetParts(expression);
    return (
      reflected !== undefined &&
      isProcessObject(reflected.object) &&
      reflectPropertyKey(reflected.property).kind !== 'variable'
    );
  }

  function isKeyedEnvironmentConsumer(node) {
    const parent = node.parent;
    if (
      parent.type === 'MemberExpression' &&
      unwrapExpression(parent.object) === node
    ) {
      return true;
    }
    const reflected = reflectGetParts(parent);
    return reflected?.object === node;
  }

  function observePattern(pattern, source, reportCapability) {
    if (pattern.type !== 'ObjectPattern') return;
    if (isProcessObject(source)) {
      for (const property of pattern.properties) {
        if (property.type !== 'Property') continue;
        const name = property.computed
          ? reflectPropertyKey(property.key).name
          : identifierName(property.key);
        const identifier = assignedIdentifier(property.value);
        if (name === 'env' && identifier) {
          addVariable(environmentVariables, identifier);
          reportCapability(property);
        }
      }
    } else if (isGlobalContainer(source)) {
      for (const property of pattern.properties) {
        const identifier =
          property.type === 'Property'
            ? assignedIdentifier(property.value)
            : undefined;
        if (
          property.type === 'Property' &&
          identifierName(property.key) === 'process' &&
          identifier
        ) {
          addVariable(processVariables, identifier);
        }
      }
    } else if (isReflectContainer(source)) {
      for (const property of pattern.properties) {
        if (property.type !== 'Property') continue;
        const name = property.computed
          ? reflectPropertyKey(property.key).name
          : identifierName(property.key);
        const identifier = assignedIdentifier(property.value);
        if (name === 'get' && identifier) {
          addVariable(reflectGetVariables, identifier);
        }
      }
    }
  }

  function observeAssignment(target, source, reportCapability) {
    if (target.type === 'Identifier') {
      if (isProcessObject(source)) addVariable(processVariables, target);
      if (isEnvironmentObject(source))
        addVariable(environmentVariables, target);
      if (isReflectGetReference(source))
        addVariable(reflectGetVariables, target);
    } else {
      observePattern(target, source, reportCapability);
    }
  }

  return {
    environmentKey,
    isEnvironmentObject,
    isKeyedEnvironmentConsumer,
    processPropertyIsUnresolved,
    ImportDeclaration(node, reportCapability) {
      if (
        node.source.value !== 'node:process' &&
        node.source.value !== 'process'
      ) {
        return;
      }
      for (const specifier of node.specifiers) {
        if (
          specifier.type === 'ImportDefaultSpecifier' ||
          specifier.type === 'ImportNamespaceSpecifier'
        ) {
          addVariable(processVariables, specifier.local);
        } else if (importedName(specifier) === 'env') {
          addVariable(environmentVariables, specifier.local);
          reportCapability(specifier);
        }
      }
    },
    VariableDeclarator(node, reportCapability) {
      if (node.init) observeAssignment(node.id, node.init, reportCapability);
    },
    AssignmentExpression(node, reportCapability) {
      if (node.operator === '=') {
        observeAssignment(node.left, node.right, reportCapability);
      }
    },
  };
}

const environmentAccessOwnership = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Keep process environment access in configuration owners or narrow file/variable exceptions.',
    },
    schema: environmentAccessOwnershipSchema,
    messages: {
      environmentAccess:
        'process.env.{{variable}} is not approved in this file. Read it through the configuration owner or add a narrow file/variable exception.',
      indirectEnvironmentAccess:
        'process.env[{{variable}}] reads whatever {{variable}} holds, not a fixed name. Use a literal so the variable is auditable, or approve {{variable}} under this file’s indirectVariables.',
      computedEnvironmentAccess:
        'Computed process.env access is restricted to configuration owners.',
    },
  },
  create(context) {
    const { isOwner, allowedVariables, allowedIndirectVariables } =
      environmentAccessPolicy(context);
    if (isOwner) return {};

    const tracker = environmentCapabilityTracker(context);

    function reportCapability(node) {
      context.report({ node, messageId: 'computedEnvironmentAccess' });
    }

    function inspectAccess(node) {
      const key = tracker.environmentKey(node);
      if (key?.kind === 'variable') {
        if (allowedVariables.has(key.name)) return;
        context.report({
          node,
          messageId: 'environmentAccess',
          data: { variable: key.name },
        });
        return;
      }
      if (key?.kind === 'indirect') {
        if (allowedIndirectVariables.has(key.name)) return;
        context.report({
          node,
          messageId: 'indirectEnvironmentAccess',
          data: { variable: key.name },
        });
        return;
      }
      if (key || tracker.processPropertyIsUnresolved(node)) {
        reportCapability(node);
        return;
      }
      if (
        tracker.isEnvironmentObject(node) &&
        !tracker.isKeyedEnvironmentConsumer(node)
      ) {
        reportCapability(node);
      }
    }

    return {
      ImportDeclaration(node) {
        tracker.ImportDeclaration(node, reportCapability);
      },
      VariableDeclarator(node) {
        tracker.VariableDeclarator(node, reportCapability);
      },
      AssignmentExpression(node) {
        tracker.AssignmentExpression(node, reportCapability);
      },
      MemberExpression(node) {
        inspectAccess(node);
      },
      CallExpression(node) {
        inspectAccess(node);
      },
    };
  },
};

function isTypeOnlyImport(node, specifier) {
  return (
    node.importKind === 'type' ||
    (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type')
  );
}

function isTypeOnlyExport(node, specifier) {
  return (
    node.exportKind === 'type' ||
    (specifier.type === 'ExportSpecifier' && specifier.exportKind === 'type')
  );
}

const E2E_FIXTURE_SOURCE = '../fixture.js';

function expectedE2eFixtureSource(context) {
  const filename = normalizedFilename(context);
  const marker = '/test/integration/e2e/specs/';
  const markerIndex = filename.indexOf(marker);
  if (markerIndex < 0) return E2E_FIXTURE_SOURCE;
  const relative = filename.slice(markerIndex + marker.length);
  const directoryDepth = Math.max(0, relative.split('/').length - 1);
  return `${'../'.repeat(directoryDepth + 1)}fixture.js`;
}

function e2eInternalLayer(context) {
  const filename = normalizedFilename(context);
  if (filename.includes('/test/integration/e2e/internal/contracts/')) {
    return 'contract';
  }
  if (filename.includes('/test/integration/e2e/internal/targets/')) {
    return 'target';
  }
  return undefined;
}

function e2eImportedName(specifier) {
  return specifier.type === 'ImportSpecifier' &&
    specifier.imported.type === 'Identifier'
    ? specifier.imported.name
    : undefined;
}

const e2eClosedLayerGlobals = new Set([
  'Bun',
  'Date',
  'Deno',
  'EventSource',
  'Function',
  'WebSocket',
  'Worker',
  'console',
  'eval',
  'fetch',
  'global',
  'globalThis',
  'performance',
  'process',
  'queueMicrotask',
  'require',
  'setImmediate',
  'setInterval',
  'setTimeout',
]);

function e2eClosedLayerAllowsImport(context, layer, source) {
  const importer = normalizedFilename(context);
  const cwd = contextCwd(context);
  const identity = resolvedImportIdentity(source, importer, cwd);
  if (!identity) return false;

  const marker = '/test/integration/e2e/internal/';
  const markerIndex = importer.indexOf(marker);
  if (markerIndex < 0) return false;
  const projectRoot = importer.slice(0, markerIndex);
  const internalRoot = `${projectRoot}${marker}`;
  const sharedOwnerRoot = `${projectRoot}/src/shared/`;
  const sharedValueOwners = new Set([
    'cloud',
    'workload',
    'image',
    'quota',
    'runtime',
  ]);
  if (
    identity.startsWith(sharedOwnerRoot) &&
    sharedValueOwners.has(identity.slice(sharedOwnerRoot.length))
  ) {
    return true;
  }

  if (layer === 'contract') {
    if (identity.startsWith(`${internalRoot}contracts/`)) return true;
    if (identity.startsWith(`${internalRoot}probes/`)) return true;
    if (identity.startsWith(`${internalRoot}targets/`)) return true;
    return new Set([
      'artifacts',
      'workloads',
      'environment',
      'host-identity',
      'names',
      'progress',
      'secrets',
      'types',
      'vm',
      'vm-ledger',
      'wait',
    ]).has(identity.slice(internalRoot.length));
  }

  if (identity.startsWith(`${internalRoot}targets/`)) return true;
  return new Set([
    // argv for the CLI the target drives, checked against the commander tree.
    'cli-surface',
    'workload-mutations',
    'workloads',
    'profiles',
  ]).has(identity.slice(internalRoot.length));
}

const noE2eRawMutationClients = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Keep constrained E2E contracts and target adapters inside their closed capability layers.',
    },
    schema: [],
    messages: {
      comment:
        'Lint suppression comments are not allowed in constrained E2E contracts or target adapters.',
      dynamicImport:
        'Dynamic imports are not allowed in constrained E2E contracts or target adapters. Inject the capability at the composition root.',
      globalCapability:
        'Direct use of {{name}} is not allowed in constrained E2E contracts or target adapters. Inject a narrow capability instead.',
      hostIdentity:
        'Contracts may import only approved type-only host-identity boundaries. The transport and harness belong in the fixture composition root.',
      kernel:
        'Import only the outcome-neutral kernel interface or opaque reference types here; the tracked kernel implementation belongs in the fixture composition root.',
      layerImport:
        '{{layer}} modules cannot import {{source}}. Keep dependencies inside the closed layer or inject a narrow capability at the composition root.',
      mechanic:
        'Target adapters cannot import {{mechanic}}. Inject a narrow, single-attempt target transport and keep lifecycle policy in the contract.',
      raw: '{{layer}} modules cannot import raw {{client}} clients. Use the tracked kernel and an approved narrow transport.',
      reexport:
        'Re-exports are not allowed in constrained E2E contracts or target adapters because they can expose capabilities across the closed layer.',
    },
  },
  create(context) {
    const layer = e2eInternalLayer(context);
    if (!layer) return {};

    function checkImport(node) {
      if (typeof node.source.value !== 'string') return;
      const source = node.source.value;
      const client = source.match(
        /(?:^|\/)(api|cli|workload-mutations)\.js$/u,
      )?.[1];
      const approvedTargetTransports = new Set([
        'WorkloadApiCreateTransport',
        'WorkloadCliCreateTransport',
        'WorkloadCliResubmitTransport',
        'WorkloadCliUpgradeTransport',
      ]);
      const importsRawMutationTransport =
        client === 'workload-mutations' &&
        node.specifiers.some(
          (specifier) =>
            !approvedTargetTransports.has(e2eImportedName(specifier)),
        );
      if (
        client &&
        (layer === 'contract' ||
          client === 'api' ||
          client === 'cli' ||
          importsRawMutationTransport)
      ) {
        context.report({
          node: node.source,
          messageId: 'raw',
          data: { client, layer },
        });
        return;
      }
      if (
        /(?:^|\/)(?:node-pools|deployments|workloads)\.js$/u.test(source) &&
        node.specifiers.some((specifier) =>
          new Set([
            'TrackedNodePoolKernel',
            'TrackedDeploymentKernel',
            'TrackedWorkloadKernel',
          ]).has(importedName(specifier)),
        )
      ) {
        context.report({ node: node.source, messageId: 'kernel' });
        return;
      }
      if (
        layer === 'contract' &&
        /(?:^|\/)host-identity\.js$/u.test(source) &&
        (node.specifiers.length === 0 ||
          node.specifiers.some(
            (specifier) =>
              !isTypeOnlyImport(node, specifier) ||
              !new Set([
                'CapturedSshHostIdentity',
                'HostIdentityCapability',
                'SshHostIdentityObservation',
              ]).has(e2eImportedName(specifier)),
          ))
      ) {
        context.report({ node: node.source, messageId: 'hostIdentity' });
        return;
      }
      if (layer === 'target') {
        if (
          /(?:^|\/)profiles\.js$/u.test(source) &&
          node.specifiers.some(
            (specifier) => importedName(specifier) !== 'VmProvider',
          )
        ) {
          context.report({
            node: node.source,
            messageId: 'mechanic',
            data: { mechanic: 'credential-bearing profiles' },
          });
          return;
        }
        const mechanic = source.match(
          /(?:^|\/)(artifacts|cleanup|environment|files|http|process|remote|secrets|transports(?:\/[^/]+)?|vm-ledger|wait)\.js$/u,
        )?.[1];
        if (mechanic) {
          context.report({
            node: node.source,
            messageId: 'mechanic',
            data: { mechanic },
          });
          return;
        }
      }
      if (!e2eClosedLayerAllowsImport(context, layer, source)) {
        context.report({
          node: node.source,
          messageId: 'layerImport',
          data: { layer, source },
        });
      }
    }

    return {
      Program(_node) {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        for (const comment of sourceCode.getAllComments()) {
          if (
            /\beslint-(?:disable(?:-next-line|-line)?|enable|env)\b/iu.test(
              comment.value,
            )
          ) {
            context.report({ node: comment, messageId: 'comment' });
          }
        }
      },
      ImportDeclaration(node) {
        checkImport(node);
      },
      ExportNamedDeclaration(node) {
        if (node.source) context.report({ node, messageId: 'reexport' });
      },
      ExportAllDeclaration(node) {
        context.report({ node, messageId: 'reexport' });
      },
      ImportExpression(node) {
        context.report({ node, messageId: 'dynamicImport' });
      },
      Identifier(node) {
        if (
          e2eClosedLayerGlobals.has(node.name) &&
          !isNonReferenceIdentifier(node)
        ) {
          context.report({
            node,
            messageId: 'globalCapability',
            data: { name: node.name },
          });
        }
      },
    };
  },
};

/**
 * Invariant 4: an adapter may only perform the operations and return the
 * observations its contract interface names. A callback lets a contract hand it
 * behaviour, and a lifecycle flag lets it decline a stage; neither is a target
 * concern, and both are invisible to the type system as ordinary members.
 */
const noE2eAdapterEscapeHatches = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Keep constrained E2E adapter and contract interfaces free of injected behaviour and lifecycle flags.',
    },
    schema: [],
    messages: {
      callback:
        'Adapter and contract interfaces cannot take a function member ({{name}}). A target supplies data and observations; behaviour belongs to the contract.',
      flag: 'Lifecycle flags are not part of a contract or adapter interface ({{name}}). A genuine outcome difference is a separate family or named extension.',
    },
  },
  create(context) {
    if (!e2eInternalLayer(context)) return {};
    const flagName = /^(?:skip|only|enable|disable|allow|force)[A-Z_]/u;
    return {
      TSPropertySignature(node) {
        if (node.key.type !== 'Identifier') return;
        const name = node.key.name;
        const annotation = node.typeAnnotation?.typeAnnotation;
        if (annotation?.type === 'TSBooleanKeyword' && flagName.test(name)) {
          context.report({ node, messageId: 'flag', data: { name } });
          return;
        }
        if (annotation?.type === 'TSFunctionType') {
          context.report({ node, messageId: 'callback', data: { name } });
        }
      },
    };
  },
};

/**
 * Invariant 10: a closed target union with one member is indistinguishable from
 * a hardcoded target, and its assertions read as general while encoding that
 * member's facts. Serve shipped exactly this shape and a second substrate cost
 * a rewrite of the stages. The alias is the visible form; requiring the union
 * to be written out makes the single-member state a deliberate declaration.
 */
const noE2eSingleMemberTargetUnion = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require constrained E2E target unions to name their members rather than alias one.',
    },
    schema: [],
    messages: {
      alias:
        '{{name}} aliases a single target. Write the union out, so adding a second member is an edit to a union rather than a rewrite of assertions that silently encoded the first member.',
    },
  },
  create(context) {
    if (e2eInternalLayer(context) !== 'target') return {};
    return {
      TSTypeAliasDeclaration(node) {
        if (!/Target$/u.test(node.id.name)) return;
        const aliased = node.typeAnnotation;
        if (
          aliased.type === 'TSTypeReference' &&
          aliased.typeName.type === 'Identifier' &&
          /Target$/u.test(aliased.typeName.name)
        ) {
          context.report({
            node,
            messageId: 'alias',
            data: { name: node.id.name },
          });
        }
      },
    };
  },
};

const noE2eRawVmLedgerAccess = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require behavioral contracts to observe VM rows through the VM ledger probe.',
    },
    schema: [],
    messages: {
      raw: 'Contracts cannot inspect StatusResponse.vms directly. Capture and compare VM facts through VmLedgerProbe.',
    },
  },
  create(context) {
    if (e2eInternalLayer(context) !== 'contract') return {};
    return {
      MemberExpression(node) {
        if (memberName(node) === 'vms') {
          context.report({ node, messageId: 'raw' });
        }
      },
      Property(node) {
        if (
          node.parent.type === 'ObjectPattern' &&
          (identifierName(node.key) === 'vms' || node.key.value === 'vms')
        ) {
          context.report({ node, messageId: 'raw' });
        }
      },
    };
  },
};

const requireE2eFixture = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require constrained E2E specs to import only the repository fixture.',
    },
    schema: [],
    messages: {
      bindings:
        'The E2E fixture import must be exactly: import { test, expect } from "{{source}}".',
      fixtureOnly:
        'Constrained E2E specs may import only "../fixture.js". Add reusable behavior to the fixture instead.',
      missing:
        'Constrained E2E specs must import { test, expect } from "{{source}}".',
      singleImport:
        'Constrained E2E specs must have exactly one import: the public fixture.',
    },
  },
  create(context) {
    return {
      Program(node) {
        const expectedSource = expectedE2eFixtureSource(context);
        const imports = node.body.filter(
          (statement) => statement.type === 'ImportDeclaration',
        );
        const fixtureImports = imports.filter(
          (statement) => statement.source.value === expectedSource,
        );

        for (const statement of imports) {
          if (statement.source.value !== expectedSource) {
            context.report({
              node: statement.source,
              messageId: 'fixtureOnly',
            });
          }
        }

        if (fixtureImports.length === 0) {
          context.report({
            node,
            messageId: 'missing',
            data: { source: expectedSource },
          });
          return;
        }
        if (imports.length !== 1 || fixtureImports.length !== 1) {
          context.report({ node, messageId: 'singleImport' });
          return;
        }

        const fixtureImport = fixtureImports[0];
        const importedNames = fixtureImport.specifiers.map((specifier) => {
          if (
            specifier.type !== 'ImportSpecifier' ||
            specifier.imported.type !== 'Identifier' ||
            specifier.local.name !== specifier.imported.name
          ) {
            return undefined;
          }
          return specifier.imported.name;
        });
        if (
          importedNames.length !== 2 ||
          !importedNames.includes('test') ||
          !importedNames.includes('expect')
        ) {
          context.report({
            node: fixtureImport,
            messageId: 'bindings',
            data: { source: expectedSource },
          });
        }
      },
    };
  },
};

function memberChain(node, names) {
  if (names.length === 1) {
    return node.type === 'Identifier' && node.name === names[0];
  }
  if (
    node.type !== 'MemberExpression' ||
    node.computed ||
    node.property.type !== 'Identifier' ||
    node.property.name !== names[names.length - 1]
  ) {
    return false;
  }
  return memberChain(node.object, names.slice(0, -1));
}

function literalValue(node, expected) {
  return node?.type === 'Literal' && node.value === expected;
}

function exactJobDescription(node, kind, target) {
  if (node?.type !== 'ObjectExpression' || node.properties.length !== 2)
    return false;
  const expected = new Map([
    ['kind', kind],
    ['target', target],
  ]);
  for (const property of node.properties) {
    if (
      property.type !== 'Property' ||
      property.computed ||
      property.kind !== 'init' ||
      property.key.type !== 'Identifier'
    )
      return false;
    const value = expected.get(property.key.name);
    if (value === undefined || !literalValue(property.value, value))
      return false;
    expected.delete(property.key.name);
  }
  return expected.size === 0;
}

function exactCompletionObject(node, family, target, kind) {
  if (
    node?.type !== 'ObjectExpression' ||
    node.properties.length !== (kind ? 5 : 4)
  ) {
    return false;
  }
  const expected = new Map([
    ['contract', family],
    ['qualification', 'conclusive'],
    ['target', target],
    ['satisfied', true],
    ...(kind ? [['member', kind]] : []),
  ]);
  for (const property of node.properties) {
    if (
      property.type !== 'Property' ||
      property.computed ||
      property.kind !== 'init' ||
      property.key.type !== 'Identifier'
    ) {
      return false;
    }
    const expectedValue = expected.get(property.key.name);
    if (
      expectedValue === undefined ||
      !(kind && property.key.name === 'member'
        ? exactJobDescription(property.value, kind, target)
        : literalValue(property.value, expectedValue))
    ) {
      return false;
    }
    expected.delete(property.key.name);
  }
  return expected.size === 0;
}

function contractSpecMetadata(context) {
  const filename = normalizedFilename(context);
  const marker = '/specs/contracts/';
  const markerIndex = filename.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const [family, basename, ...extra] = filename
    .slice(markerIndex + marker.length)
    .split('/');
  if (
    !family ||
    !basename ||
    extra.length > 0 ||
    !basename.endsWith('.spec.ts')
  ) {
    return { unsupported: true };
  }
  if (family === 'dedicated-job') {
    const members = new Map([
      ['aws-invalid.spec.ts', { kind: 'invalid-admission', target: 'aws' }],
      ['azure-invalid.spec.ts', { kind: 'invalid-admission', target: 'azure' }],
      ['gcp-invalid.spec.ts', { kind: 'invalid-admission', target: 'gcp' }],
      ['gcp-disk-tier.spec.ts', { kind: 'disk-tier', target: 'gcp' }],
      ['azure-ghcr-probe.spec.ts', { kind: 'ghcr-probe', target: 'azure' }],
      ['aws-mace-full-pull.spec.ts', { kind: 'mace-full-pull', target: 'aws' }],
      [
        'azure-mace-full-pull.spec.ts',
        { kind: 'mace-full-pull', target: 'azure' },
      ],
      ['gcp-mace-full-pull.spec.ts', { kind: 'mace-full-pull', target: 'gcp' }],
      [
        'lambda-mace-full-pull.spec.ts',
        { kind: 'mace-full-pull', target: 'lambda' },
      ],
      ['aws-bucket-sync.spec.ts', { kind: 'bucket-sync', target: 'aws' }],
      ['azure-bucket-sync.spec.ts', { kind: 'bucket-sync', target: 'azure' }],
      ['gcp-bucket-sync.spec.ts', { kind: 'bucket-sync', target: 'gcp' }],
      ['lambda-bucket-sync.spec.ts', { kind: 'bucket-sync', target: 'lambda' }],
      [
        'aws-input-hydration-recovery.spec.ts',
        { kind: 'input-hydration-recovery', target: 'aws' },
      ],
      [
        'aws-spot-request-cleanup.spec.ts',
        { kind: 'spot-request-cleanup', target: 'aws' },
      ],
      ...['aws', 'azure', 'gcp', 'lambda'].map((target) => [
        `${target}-runtime-secrets.spec.ts`,
        { kind: 'runtime-secrets', target },
      ]),
      ['aws-spot-eviction.spec.ts', { kind: 'spot-eviction', target: 'aws' }],
      [
        'azure-spot-eviction.spec.ts',
        { kind: 'spot-eviction', target: 'azure' },
      ],
      ['gcp-spot-eviction.spec.ts', { kind: 'spot-eviction', target: 'gcp' }],
      [
        'azure-gpu-spot-eviction.spec.ts',
        { kind: 'gpu-spot-eviction', target: 'azure' },
      ],
      ...['aws', 'azure', 'gcp', 'lambda'].map((target) => [
        `${target}-gpu-probe-rerun.spec.ts`,
        { kind: 'gpu-probe-rerun', target },
      ]),
      [
        'aws-restricted-credential.spec.ts',
        { kind: 'restricted-credential', target: 'aws' },
      ],
      [
        'azure-restricted-credential.spec.ts',
        { kind: 'restricted-credential', target: 'azure' },
      ],
      ...['aws', 'azure', 'gcp'].map((target) => [
        `${target}-host-docker.spec.ts`,
        { kind: 'host-docker', target },
      ]),
      [
        'aws-job-host-unreachable.spec.ts',
        { kind: 'host-recovery', target: 'aws' },
      ],
      [
        'azure-job-host-unreachable.spec.ts',
        { kind: 'host-recovery', target: 'azure' },
      ],
      [
        'gcp-job-host-unreachable.spec.ts',
        { kind: 'host-recovery', target: 'gcp' },
      ],
      [
        'aws-concurrent-output.spec.ts',
        { kind: 'concurrent-output', target: 'aws' },
      ],
      [
        'azure-concurrent-output.spec.ts',
        { kind: 'concurrent-output', target: 'azure' },
      ],
      [
        'gcp-concurrent-output.spec.ts',
        { kind: 'concurrent-output', target: 'gcp' },
      ],
      [
        'local-held-job.spec.ts',
        { kind: 'local-held', target: 'local-smolvm' },
      ],
      [
        'local-completed-job.spec.ts',
        { kind: 'local-completed', target: 'local-smolvm' },
      ],
      [
        'local-resubmitted-job.spec.ts',
        { kind: 'local-resubmitted', target: 'local-smolvm' },
      ],
    ]);
    const member = members.get(basename);
    return member
      ? { family, method: 'dedicatedJob', ...member }
      : { unsupported: true };
  }
  const definitions = new Map([
    [
      'persistent-vm',
      {
        method: 'persistentVm',
        suffix: '-vm.spec.ts',
      },
    ],
    [
      'persistent-vm-host-loss',
      {
        method: 'persistentVmHostLoss',
        suffix: '-vm-host-loss.spec.ts',
      },
    ],
    [
      'serve',
      {
        method: 'serve',
        suffix: '-serve.spec.ts',
      },
    ],
    [
      'gpu-serve',
      {
        method: 'gpuServe',
        suffix: '-gpu-serve.spec.ts',
      },
    ],
    [
      'serve-local-recovery',
      {
        method: 'serveLocalRecovery',
        suffix: '-serve.spec.ts',
      },
    ],
    [
      'serve-upgrade',
      {
        method: 'serveUpgrade',
        suffix: '-serve-upgrade.spec.ts',
      },
    ],
    [
      'storage-tokens',
      {
        method: 'storageTokens',
        suffix: '-storage-tokens.spec.ts',
      },
    ],
  ]);
  const definition = definitions.get(family);
  if (!definition || !basename.endsWith(definition.suffix)) {
    return { unsupported: true };
  }
  return {
    family,
    method: definition.method,
    target: basename.slice(0, -definition.suffix.length),
  };
}

function exactContractInvocation(statement, method, target, kind) {
  if (
    statement?.type !== 'VariableDeclaration' ||
    statement.kind !== 'const' ||
    statement.declarations.length !== 1
  ) {
    return false;
  }
  const [declaration] = statement.declarations;
  const awaited = declaration.init;
  if (
    declaration.id.type !== 'Identifier' ||
    declaration.id.name !== 'result' ||
    awaited?.type !== 'AwaitExpression' ||
    awaited.argument.type !== 'CallExpression'
  ) {
    return false;
  }
  const call = awaited.argument;
  return (
    memberChain(call.callee, ['e2e', 'contracts', method]) &&
    call.arguments.length === 1 &&
    (kind
      ? exactJobDescription(call.arguments[0], kind, target)
      : literalValue(call.arguments[0], target))
  );
}

function exactContractExpectation(statement, family, target, kind) {
  if (
    statement?.type !== 'ExpressionStatement' ||
    statement.expression.type !== 'CallExpression'
  ) {
    return false;
  }
  const assertion = statement.expression;
  if (
    assertion.arguments.length !== 1 ||
    !exactCompletionObject(assertion.arguments[0], family, target, kind) ||
    assertion.callee.type !== 'MemberExpression' ||
    assertion.callee.computed ||
    assertion.callee.property.type !== 'Identifier' ||
    assertion.callee.property.name !== 'toEqual' ||
    assertion.callee.object.type !== 'CallExpression'
  ) {
    return false;
  }
  const expectCall = assertion.callee.object;
  return (
    expectCall.callee.type === 'Identifier' &&
    expectCall.callee.name === 'expect' &&
    expectCall.arguments.length === 1 &&
    expectCall.arguments[0].type === 'Identifier' &&
    expectCall.arguments[0].name === 'result'
  );
}

const validE2eContractSpec = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require provider contract members to select one target through the shared family runner.',
    },
    schema: [],
    messages: {
      shape:
        'Contract member specs must contain one test whose body is exactly a shared {{family}} contract call for target "{{target}}" and its exact completion assertion.',
      unsupported:
        'This contract path has no repository-enforced family shape. Add the family rule before adding member specs.',
    },
  },
  create(context) {
    const metadata = contractSpecMetadata(context);
    if (!metadata) return {};
    return {
      Program(node) {
        if (metadata.unsupported) {
          context.report({ node, messageId: 'unsupported' });
          return;
        }
        const statements = node.body.filter(
          (statement) => statement.type !== 'ImportDeclaration',
        );
        const [statement] = statements;
        const call = directTestStatement(statement)
          ? statement.expression
          : undefined;
        const callback = call?.arguments[1];
        const body =
          callback?.type === 'ArrowFunctionExpression' &&
          callback.body.type === 'BlockStatement'
            ? callback.body.body
            : [];
        if (
          statements.length !== 1 ||
          !call ||
          body.length !== 2 ||
          !exactContractInvocation(
            body[0],
            metadata.method,
            metadata.target,
            metadata.kind,
          ) ||
          !exactContractExpectation(
            body[1],
            metadata.family,
            metadata.target,
            metadata.kind,
          )
        ) {
          context.report({
            node: statement ?? node,
            messageId: 'shape',
            data: { family: metadata.family, target: metadata.target },
          });
        }
      },
    };
  },
};

function directTestStatement(statement) {
  return (
    statement?.type === 'ExpressionStatement' &&
    statement.expression.type === 'CallExpression' &&
    statement.expression.callee.type === 'Identifier' &&
    statement.expression.callee.name === 'test'
  );
}

function hasE2eContextParameter(callback) {
  if (
    callback.type !== 'ArrowFunctionExpression' ||
    !callback.async ||
    callback.params.length !== 1
  ) {
    return false;
  }

  const [parameter] = callback.params;
  if (parameter.type !== 'ObjectPattern' || parameter.properties.length !== 1) {
    return false;
  }

  const [property] = parameter.properties;
  return (
    property.type === 'Property' &&
    property.kind === 'init' &&
    property.computed === false &&
    property.shorthand === true &&
    property.key.type === 'Identifier' &&
    property.key.name === 'e2e' &&
    property.value.type === 'Identifier' &&
    property.value.name === 'e2e'
  );
}

function rootCallName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression') return rootCallName(callee.object);
  return undefined;
}

const validE2eSpecShape = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Keep constrained E2E specs as direct fixture-backed test cases.',
    },
    schema: [],
    messages: {
      callback:
        'Use an async arrow callback with exactly the fixture context: async ({ e2e }) => { ... }.',
      forbiddenApi:
        '{{name}} is outside the constrained E2E spec language. Put reusable setup or teardown in the fixture.',
      missing: 'A constrained E2E spec must contain at least one test case.',
      nested:
        'E2E test cases must be direct top-level test(...) calls; nested tests and test modifiers are not allowed.',
      signature:
        'Use exactly test("literal title", async ({ e2e }) => { ... }); fixture-owned configuration supplies timeouts.',
      topLevel:
        'Only the public fixture import and direct test(...) calls are allowed at the top level.',
    },
  },
  create(context) {
    const forbiddenApis = new Set([
      'afterAll',
      'afterEach',
      'beforeAll',
      'beforeEach',
      'bench',
      'describe',
      'it',
      'suite',
    ]);

    return {
      Program(node) {
        let testCount = 0;
        for (const statement of node.body) {
          if (statement.type === 'ImportDeclaration') continue;
          if (!directTestStatement(statement)) {
            context.report({ node: statement, messageId: 'topLevel' });
            continue;
          }

          testCount += 1;
          const call = statement.expression;
          const [title, callback] = call.arguments;
          if (
            call.arguments.length !== 2 ||
            title?.type !== 'Literal' ||
            typeof title.value !== 'string' ||
            title.value.trim().length === 0 ||
            !callback ||
            callback.type === 'SpreadElement'
          ) {
            context.report({ node: call, messageId: 'signature' });
            continue;
          }
          if (!hasE2eContextParameter(callback)) {
            context.report({ node: callback, messageId: 'callback' });
          }
        }

        if (testCount === 0) {
          context.report({ node, messageId: 'missing' });
        }
      },
      CallExpression(node) {
        const name = rootCallName(node.callee);
        if (name && forbiddenApis.has(name)) {
          context.report({
            node: node.callee,
            messageId: 'forbiddenApi',
            data: { name },
          });
          return;
        }
        if (name !== 'test') return;

        const parent = node.parent;
        const isDirect =
          node.callee.type === 'Identifier' &&
          parent.type === 'ExpressionStatement' &&
          parent.parent.type === 'Program';
        if (!isDirect) {
          context.report({ node: node.callee, messageId: 'nested' });
        }
      },
    };
  },
};

function isNonReferenceIdentifier(node) {
  const parent = node.parent;
  return (
    (parent.type === 'MemberExpression' &&
      parent.property === node &&
      !parent.computed) ||
    (parent.type === 'Property' &&
      parent.key === node &&
      !parent.computed &&
      !parent.shorthand) ||
    parent.type === 'ImportSpecifier'
  );
}

const noE2eEscapeHatches = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow direct process, time, network, mock, and suppression escape hatches in constrained E2E specs.',
    },
    schema: [],
    messages: {
      comment:
        'Lint suppression comments are not allowed in constrained E2E specs. Change the fixture contract or the repository rule.',
      dynamicImport:
        'Dynamic imports are not allowed in constrained E2E specs. Dependencies belong behind the fixture.',
      global:
        'Direct use of {{name}} is not allowed in constrained E2E specs. Use the e2e fixture capability instead.',
    },
  },
  create(context) {
    const forbiddenGlobals = new Set([
      'Bun',
      'Date',
      'Deno',
      'EventSource',
      'Function',
      'WebSocket',
      'Worker',
      'console',
      'eval',
      'fetch',
      'global',
      'globalThis',
      'performance',
      'process',
      'queueMicrotask',
      'require',
      'setImmediate',
      'setInterval',
      'setTimeout',
      'vi',
    ]);

    return {
      Program(_node) {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        for (const comment of sourceCode.getAllComments()) {
          if (
            /\beslint-(?:disable(?:-next-line|-line)?|enable|env)\b/iu.test(
              comment.value,
            )
          ) {
            context.report({ node: comment, messageId: 'comment' });
          }
        }
      },
      ImportExpression(node) {
        context.report({ node, messageId: 'dynamicImport' });
      },
      Identifier(node) {
        if (
          forbiddenGlobals.has(node.name) &&
          !isNonReferenceIdentifier(node)
        ) {
          context.report({
            node,
            messageId: 'global',
            data: { name: node.name },
          });
        }
      },
    };
  },
};

const EXPRESS_ROUTE_METHODS = new Set([
  'all',
  'checkout',
  'connect',
  'copy',
  'delete',
  'get',
  'head',
  'lock',
  'm-search',
  'merge',
  'mkactivity',
  'mkcol',
  'move',
  'notify',
  'options',
  'patch',
  'post',
  'propfind',
  'proppatch',
  'purge',
  'put',
  'report',
  'route',
  'search',
  'subscribe',
  'trace',
  'unlock',
  'unsubscribe',
]);

function importedName(specifier) {
  if (specifier.type !== 'ImportSpecifier') return undefined;
  return specifier.imported.type === 'Identifier'
    ? specifier.imported.name
    : specifier.imported.value;
}

function isValueImport(node, specifier) {
  return node.importKind !== 'type' && specifier.importKind !== 'type';
}

const noUncontractedApiRoutes = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require conventional JSON API routes to use the shared oRPC contract.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowedFiles: {
            type: 'array',
            items: { type: 'string' },
            uniqueItems: true,
          },
        },
        required: ['allowedFiles'],
        additionalProperties: false,
      },
    ],
    messages: {
      route:
        'Define conventional JSON endpoints in src/shared/api-contract and src/api/rpc. Native Express transports must be registered in a configured owner module.',
    },
  },
  create(context) {
    if (isAllowedOwner(context)) return {};

    const appFactories = new Set();
    const routerFactories = new Set();
    const expressNamespaces = new Set();
    const expressReceivers = new Set();
    const expressRouteFunctions = new Set();
    const expressTypeNames = new Set(['Application', 'Router']);
    const variableDeclarators = [];
    const assignments = [];
    const functions = [];
    const calls = [];
    const ambiguousRouteProperties = new Set();
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    const parserServices = sourceCode.parserServices;
    const checker = parserServices?.program?.getTypeChecker();

    function variableIsIn(variableSet, identifier) {
      const variable = resolvedVariable(context, identifier);
      return variable !== undefined && variableSet.has(variable);
    }

    function addVariable(variableSet, identifier) {
      const variable = resolvedVariable(context, identifier);
      if (!variable || variableSet.has(variable)) return false;
      variableSet.add(variable);
      return true;
    }

    function typeName(annotation) {
      const type = annotation?.typeAnnotation;
      if (type?.type !== 'TSTypeReference') return undefined;
      if (type.typeName.type === 'Identifier') return type.typeName.name;
      if (type.typeName.type === 'TSQualifiedName') {
        return type.typeName.right.name;
      }
      return undefined;
    }

    function typeIsExpressReceiver(node) {
      if (!checker || !parserServices?.esTreeNodeToTSNodeMap) return false;
      try {
        const type = checker.getTypeAtLocation(
          parserServices.esTreeNodeToTSNodeMap.get(node),
        );
        const seen = new Set();
        const inspect = (candidate) => {
          if (!candidate || seen.has(candidate)) return false;
          seen.add(candidate);
          if (candidate.isUnionOrIntersection?.()) {
            return candidate.types.some(inspect);
          }
          const symbol = candidate.aliasSymbol ?? candidate.getSymbol?.();
          if (
            symbol &&
            ['Application', 'Express', 'IRouter', 'Router'].includes(
              symbol.getName(),
            ) &&
            (symbol.declarations ?? []).some((declaration) =>
              declaration
                .getSourceFile()
                .fileName.replaceAll('\\', '/')
                .includes('/@types/express-serve-static-core/'),
            )
          ) {
            return true;
          }
          return (candidate.getBaseTypes?.() ?? []).some(inspect);
        };
        return inspect(type);
      } catch {
        return false;
      }
    }

    function isExpressReceiver(node) {
      const expression = unwrapExpression(node);
      return (
        isExpressFactoryCall(expression) ||
        (expression?.type === 'Identifier' &&
          variableIsIn(expressReceivers, expression)) ||
        (expression !== undefined && typeIsExpressReceiver(expression))
      );
    }

    function addTypedParameters(params) {
      let changed = false;
      for (const parameter of params) {
        const candidate =
          parameter.type === 'AssignmentPattern' ? parameter.left : parameter;
        const typedReceiver =
          expressTypeNames.has(typeName(candidate.typeAnnotation)) ||
          typeIsExpressReceiver(candidate);
        if (!typedReceiver) continue;
        if (candidate.type === 'Identifier') {
          changed = addVariable(expressReceivers, candidate) || changed;
        } else if (candidate.type === 'ObjectPattern') {
          changed = observeReceiverPattern(candidate) || changed;
        }
      }
      return changed;
    }

    function routeMethodReference(node) {
      const expression = unwrapExpression(node);
      if (
        expression?.type === 'MemberExpression' &&
        isExpressReceiver(expression.object)
      ) {
        const method = memberName(expression);
        if (method && EXPRESS_ROUTE_METHODS.has(method)) return expression;
        if (expression.computed && method === undefined) return expression;
        return undefined;
      }
      if (
        expression?.type === 'CallExpression' &&
        expression.callee.type === 'MemberExpression' &&
        isUnshadowedGlobal(context, expression.callee.object, 'Reflect') &&
        memberName(expression.callee) === 'get' &&
        expression.arguments[0] &&
        isExpressReceiver(expression.arguments[0])
      ) {
        const method = literalModuleSpecifier(expression.arguments[1]);
        if (method === undefined || EXPRESS_ROUTE_METHODS.has(method)) {
          return expression;
        }
      }
      return undefined;
    }

    function isExpressFactoryCall(node) {
      if (node?.type !== 'CallExpression') return false;
      if (node.callee.type === 'Identifier') {
        return (
          variableIsIn(appFactories, node.callee) ||
          variableIsIn(routerFactories, node.callee)
        );
      }
      return (
        memberName(node.callee) === 'Router' &&
        node.callee.object.type === 'Identifier' &&
        variableIsIn(expressNamespaces, node.callee.object)
      );
    }

    function isBoundRouteFunction(node) {
      const expression = unwrapExpression(node);
      return (
        expression?.type === 'CallExpression' &&
        expression.callee.type === 'MemberExpression' &&
        memberName(expression.callee) === 'bind' &&
        routeMethodReference(expression.callee.object) !== undefined
      );
    }

    function observeReceiverPattern(pattern) {
      let changed = false;
      for (const property of pattern.properties) {
        if (property.type !== 'Property') continue;
        const method = property.computed
          ? literalModuleSpecifier(property.key)
          : identifierName(property.key);
        if (method === undefined && property.computed) {
          ambiguousRouteProperties.add(property);
          continue;
        }
        const identifier = assignedIdentifier(property.value);
        if (method && EXPRESS_ROUTE_METHODS.has(method) && identifier) {
          changed = addVariable(expressRouteFunctions, identifier) || changed;
        }
      }
      return changed;
    }

    function processVariableDeclarator(node) {
      if (!node.init) return false;
      if (node.id.type === 'ObjectPattern') {
        return isExpressReceiver(node.init)
          ? observeReceiverPattern(node.id)
          : false;
      }
      if (node.id.type !== 'Identifier') return false;

      let changed = false;
      const init = unwrapExpression(node.init);
      if (isExpressReceiver(init)) {
        changed = addVariable(expressReceivers, node.id) || changed;
      }
      if (init?.type === 'Identifier') {
        if (variableIsIn(appFactories, init)) {
          changed = addVariable(appFactories, node.id) || changed;
        }
        if (variableIsIn(routerFactories, init)) {
          changed = addVariable(routerFactories, node.id) || changed;
        }
        if (variableIsIn(expressNamespaces, init)) {
          changed = addVariable(expressNamespaces, node.id) || changed;
        }
        if (variableIsIn(expressRouteFunctions, init)) {
          changed = addVariable(expressRouteFunctions, node.id) || changed;
        }
      }
      if (routeMethodReference(init) || isBoundRouteFunction(init)) {
        changed = addVariable(expressRouteFunctions, node.id) || changed;
      }
      return changed;
    }

    function processAssignment(node) {
      if (node.operator !== '=') return false;
      if (node.left.type === 'ObjectPattern') {
        return isExpressReceiver(node.right)
          ? observeReceiverPattern(node.left)
          : false;
      }
      if (node.left.type !== 'Identifier') return false;
      return processVariableDeclarator({
        type: 'VariableDeclarator',
        id: node.left,
        init: node.right,
      });
    }

    function localFunction(node, seen = new Set()) {
      const expression = unwrapExpression(node);
      if (
        expression?.type === 'ArrowFunctionExpression' ||
        expression?.type === 'FunctionExpression'
      ) {
        return expression;
      }
      if (expression?.type !== 'Identifier') return undefined;
      const variable = resolvedVariable(context, expression);
      if (!variable || seen.has(variable)) return undefined;
      seen.add(variable);
      for (const definition of variable.defs) {
        if (definition.node?.type === 'FunctionDeclaration') {
          return definition.node;
        }
        if (definition.node?.type === 'VariableDeclarator') {
          const resolved = localFunction(definition.node.init, seen);
          if (resolved) return resolved;
        }
      }
      return undefined;
    }

    function receiverParameter(pattern, argument) {
      if (!isExpressReceiver(argument)) return false;
      const candidate =
        pattern.type === 'AssignmentPattern' ? pattern.left : pattern;
      if (candidate.type === 'Identifier') {
        return addVariable(expressReceivers, candidate);
      }
      if (candidate.type === 'ObjectPattern') {
        return observeReceiverPattern(candidate);
      }
      return false;
    }

    function propagateHelperArguments(node) {
      const helper = localFunction(node.callee);
      if (!helper) return false;
      let changed = false;
      for (const [index, parameter] of helper.params.entries()) {
        const argument = node.arguments[index];
        if (!argument || argument.type === 'SpreadElement') continue;
        changed = receiverParameter(parameter, argument) || changed;
      }
      return changed;
    }

    function inspectRouteCall(node) {
      if (
        node.callee.type === 'Identifier' &&
        variableIsIn(expressRouteFunctions, node.callee)
      ) {
        context.report({ node: node.callee, messageId: 'route' });
        return;
      }
      const routeReference = routeMethodReference(node.callee);
      if (routeReference) {
        context.report({ node: routeReference, messageId: 'route' });
        return;
      }
      if (
        node.callee.type === 'MemberExpression' &&
        (memberName(node.callee) === 'call' ||
          memberName(node.callee) === 'apply')
      ) {
        const invokedRoute = routeMethodReference(node.callee.object);
        if (invokedRoute) {
          context.report({ node: invokedRoute, messageId: 'route' });
        }
      }
    }

    return {
      ImportDeclaration(node) {
        if (node.source.value !== 'express') return;
        for (const specifier of node.specifiers) {
          const imported = importedName(specifier);
          if (imported === 'Application' || imported === 'Router') {
            expressTypeNames.add(specifier.local.name);
          }
          if (!isValueImport(node, specifier)) continue;
          if (specifier.type === 'ImportDefaultSpecifier') {
            addVariable(appFactories, specifier.local);
            addVariable(expressNamespaces, specifier.local);
          } else if (specifier.type === 'ImportNamespaceSpecifier') {
            addVariable(expressNamespaces, specifier.local);
          } else if (importedName(specifier) === 'Router') {
            addVariable(routerFactories, specifier.local);
          }
        }
      },
      VariableDeclarator(node) {
        variableDeclarators.push(node);
        processVariableDeclarator(node);
      },
      AssignmentExpression(node) {
        assignments.push(node);
        processAssignment(node);
      },
      FunctionDeclaration(node) {
        functions.push(node);
        addTypedParameters(node.params);
      },
      FunctionExpression(node) {
        functions.push(node);
        addTypedParameters(node.params);
      },
      ArrowFunctionExpression(node) {
        functions.push(node);
        addTypedParameters(node.params);
      },
      CallExpression(node) {
        calls.push(node);
      },
      'Program:exit'() {
        let changed = true;
        while (changed) {
          changed = false;
          for (const node of variableDeclarators) {
            changed = processVariableDeclarator(node) || changed;
          }
          for (const node of assignments) {
            changed = processAssignment(node) || changed;
          }
          for (const node of functions) {
            changed = addTypedParameters(node.params) || changed;
          }
          for (const node of calls) {
            changed = propagateHelperArguments(node) || changed;
          }
        }
        for (const property of ambiguousRouteProperties) {
          context.report({ node: property, messageId: 'route' });
        }
        for (const node of calls) {
          inspectRouteCall(node);
        }
      },
    };
  },
};

function matchesProtectedRule(rule, protectedRules) {
  return protectedRules.some((protectedRule) => {
    const separator = protectedRule.lastIndexOf('/');
    const unqualified =
      separator === -1 ? protectedRule : protectedRule.slice(separator + 1);
    return rule === protectedRule || rule === unqualified;
  });
}

function protectedRuleDisable(comment, protectedRules) {
  const match = comment.match(
    /^\s*eslint-disable(?<scope>-next-line|-line)?(?:\s+(?<body>[\s\S]*?))?\s*$/,
  );
  if (!match?.groups) return undefined;

  const body = match.groups.body?.trim() ?? '';
  const separator = body.indexOf('--');
  const rulesText = (separator === -1 ? body : body.slice(0, separator)).trim();
  const reason = separator === -1 ? '' : body.slice(separator + 2).trim();
  const rules = rulesText.split(/[\s,]+/).filter(Boolean);
  const targetsProtectedRule =
    rules.length === 0 ||
    rules.some((rule) => matchesProtectedRule(rule, protectedRules));
  if (!targetsProtectedRule) return undefined;

  return {
    isNarrow:
      match.groups.scope === '-next-line' &&
      rules.length === 1 &&
      matchesProtectedRule(rules[0], protectedRules),
    reason,
  };
}

const protectedRuleDisablePolicy = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require protected ESLint rule exceptions to be narrow and justified.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          protectedRules: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            uniqueItems: true,
          },
        },
        required: ['protectedRules'],
        additionalProperties: false,
      },
    ],
    messages: {
      broad:
        'Disable only one protected rule on the next line. File-wide, same-line, ruleless, and multi-rule exceptions are not allowed.',
      reason: 'Protected rule exceptions require a reason after `--`.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    const protectedRules = context.options[0]?.protectedRules ?? [];
    return {
      Program() {
        for (const comment of sourceCode.getAllComments()) {
          const disable = protectedRuleDisable(comment.value, protectedRules);
          if (!disable) continue;
          if (!disable.isNarrow) {
            context.report({ loc: comment.loc, messageId: 'broad' });
          } else if (!disable.reason) {
            context.report({ loc: comment.loc, messageId: 'reason' });
          }
        }
      },
    };
  },
};

const noBarrelReexports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require consumers to import every symbol from its canonical owner.',
    },
    schema: [],
    messages: {
      reexport:
        'Do not re-export another module. Import this symbol from its canonical owner instead.',
    },
  },
  create(context) {
    const report = (node) => context.report({ node, messageId: 'reexport' });
    const importedBindings = new Set();
    const localExports = [];
    return {
      ImportDeclaration(node) {
        for (const specifier of node.specifiers) {
          importedBindings.add(specifier.local.name);
        }
      },
      ExportAllDeclaration(node) {
        report(node.source);
      },
      ExportNamedDeclaration(node) {
        if (node.source) {
          report(node.source);
          return;
        }
        for (const specifier of node.specifiers) {
          if (specifier.local.type === 'Identifier') {
            localExports.push({ name: specifier.local.name, node: specifier });
          }
        }
      },
      ExportDefaultDeclaration(node) {
        if (node.declaration.type === 'Identifier') {
          localExports.push({
            name: node.declaration.name,
            node: node.declaration,
          });
        }
      },
      'Program:exit'() {
        for (const exported of localExports) {
          if (importedBindings.has(exported.name)) report(exported.node);
        }
      },
    };
  },
};

const exactVmLifecycleNames = new Set([
  'terminateVMs',
  'observeVMReleaseOnce',
  'confirmVMRelease',
  'verifyVMPreemption',
  'startVM',
]);
const exactVmLifecycleOwners = [
  'src/api/services/vm-compute.ts',
  ...['cloud', 'aws', 'azure', 'gcp', 'lambda', 'local'].map(
    (provider) => `src/api/services/gateways/${provider}.ts`,
  ),
];
const vmComputeBindingOwners = [
  'src/api/services/vm-compute.ts',
  'src/api/services/host-runtime/termination.ts',
  'src/api/services/node-pool-controller.ts',
];

// As with literal-module-loads, reserve the capability names in every literal
// position. Extraction, aliases, destructuring, and Reflect.get cannot provide
// an accidental escape. Constructed spellings remain review's responsibility.
const exactVmComputeOwnership = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Bind exact VM lifecycle operations to one immutable compute handle.',
    },
    schema: [],
    messages: {
      lifecycle:
        '{{name}} belongs to VmCompute or a named provider gateway. Consume a bound VM handle here.',
      binding:
        'bindVmCompute belongs to the named Workload and node pool composition roots.',
    },
  },
  create(context) {
    const file = normalizedFilename(context);
    const owns = (owners) =>
      owners.some(
        (owner) => file === normalizedAbsolutePath(owner, contextCwd(context)),
      );
    const canUseRawLifecycle = owns(exactVmLifecycleOwners);
    const canBind = owns(vmComputeBindingOwners);
    const check = (node, name) => {
      if (!canUseRawLifecycle && exactVmLifecycleNames.has(name)) {
        context.report({ node, messageId: 'lifecycle', data: { name } });
      } else if (!canBind && name === 'bindVmCompute') {
        context.report({ node, messageId: 'binding' });
      }
    };
    return {
      Identifier(node) {
        check(node, node.name);
      },
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
      TemplateLiteral(node) {
        check(node, literalModuleSpecifier(node));
      },
    };
  },
};

const RETRY_LOOP_NAME = /^(?:attempts?|retry|retries|tries)$/iu;
const RETRY_LOOP_PAUSE = /^(?:pause|sleep|setTimeout|wait)$/u;

// Children of `node` in its own scope: nested functions are skipped, except
// the executor of `new Promise(...)`, the usual hand-written sleep.
function* ownScope(node) {
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      if (!child || typeof child.type !== 'string') continue;
      const executor =
        node.type === 'NewExpression' &&
        node.callee.type === 'Identifier' &&
        node.callee.name === 'Promise';
      if (/Function/u.test(child.type) && !executor) continue;
      yield child;
      yield* ownScope(child);
    }
  }
}

const noHandWrittenRetryLoops = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Retry through the shared Waiter instead of a hand-written loop.',
    },
    schema: [],
    messages: {
      loop: 'Retry with Waiter.for (test/integration/e2e/internal/wait.ts) and a named ProbeRetryPolicy instead of a hand-written loop; a pause schedule covers attempt counts and backoff.',
    },
  },
  create(context) {
    const check = (node) => {
      const header =
        node.type === 'ForStatement'
          ? [node.init, node.test, node.update]
          : node.type === 'WhileStatement' || node.type === 'DoWhileStatement'
            ? [node.test]
            : [];
      const body = [...ownScope(node.body)];
      const pauses = body.some(({ type, callee }) => {
        if (type !== 'CallExpression') return false;
        const name =
          callee.type === 'Identifier'
            ? callee.name
            : callee.type === 'MemberExpression' && !callee.computed
              ? callee.property.name
              : undefined;
        return RETRY_LOOP_PAUSE.test(name ?? '');
      });
      // A sampler pauses too, but only a retry can stop early once it
      // succeeds: it breaks, returns or catches, or its condition awaits a
      // probe or reads a result the body re-assigns.
      const tested = header.flatMap((part) =>
        part ? [part, ...ownScope(part)] : [],
      );
      const testedNames = new Set(
        tested.filter(({ type }) => type === 'Identifier').map((id) => id.name),
      );
      const endsEarly =
        body.some(
          (child) =>
            ['BreakStatement', 'ReturnStatement', 'TryStatement'].includes(
              child.type,
            ) ||
            (child.type === 'AssignmentExpression' &&
              child.left.type === 'Identifier' &&
              testedNames.has(child.left.name)),
        ) || tested.some(({ type }) => type === 'AwaitExpression');
      if (
        [...testedNames].some((name) => RETRY_LOOP_NAME.test(name)) ||
        (pauses && endsEarly)
      )
        context.report({ node, messageId: 'loop' });
    };
    return {
      ForStatement: check,
      ForOfStatement: check,
      ForInStatement: check,
      WhileStatement: check,
      DoWhileStatement: check,
    };
  },
};

const plugin = {
  meta: {
    name: 'eslint-plugin-local',
  },
  configs: {},
  processors: {},
  rules: {
    'api-contract-builder-ownership': apiContractBuilderOwnership,
    'api-contract-inspection-ownership': apiContractInspectionOwnership,
    'no-e2e-escape-hatches': noE2eEscapeHatches,
    'no-e2e-adapter-escape-hatches': noE2eAdapterEscapeHatches,
    'no-e2e-raw-mutation-clients': noE2eRawMutationClients,
    'no-hand-written-retry-loops': noHandWrittenRetryLoops,
    'no-e2e-single-member-target-union': noE2eSingleMemberTargetUnion,
    'no-e2e-raw-vm-ledger-access': noE2eRawVmLedgerAccess,
    'require-e2e-fixture': requireE2eFixture,
    'valid-e2e-contract-spec': validE2eContractSpec,
    'valid-e2e-spec-shape': validE2eSpecShape,
    'workload-admission-write-ownership': workloadAdmissionWriteOwnership,
    'container-spec-write-ownership': containerSpecWriteOwnership,
    'environment-access-ownership': environmentAccessOwnership,
    'literal-module-loads': literalModuleLoads,
    'explicit-api-provider-credentials': explicitApiProviderCredentials,
    'exact-vm-compute-ownership': exactVmComputeOwnership,
    'no-barrel-reexports': noBarrelReexports,
    'workload-event-metadata-ownership': workloadEventMetadataOwnership,
    'no-hand-rolled-error-message': noHandRolledErrorMessage,
    'no-raw-error-in-persisted-metadata': noRawErrorInPersistedMetadata,
    'no-skipped-or-focused-tests': noSkippedOrFocusedTests,
    'no-test-mode-in-provider-runtime': noTestModeInProviderRuntime,
    'no-unsafe-type-assertions': noUnsafeTypeAssertions,
    'no-uncontracted-api-routes': noUncontractedApiRoutes,
    'protected-rule-disable-policy': protectedRuleDisablePolicy,
  },
};

export default plugin;
