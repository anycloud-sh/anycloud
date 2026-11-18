import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import anycloudAccess from '../../../../src/shared/cloud-policies/aws-anycloud-access.json' with { type: 'json' };

/**
 * RFC 0047 invariant 6: the published `AnycloudAccess` policy grants exactly
 * the AWS actions Anycloud sends with the customer's key. The scan is static,
 * so it sees every path, not only the ones a test drives.
 */

// IAM prefixes that differ from the `@aws-sdk/client-*` package name.
const PREFIX_RENAMES: Record<string, string> = {
  'client-cost-explorer': 'ce',
  'client-service-quotas': 'servicequotas',
};

// SDK operations whose IAM actions have other names. Any other operation maps
// to `<prefix>:<Operation>` and must match a granted action exactly (no
// wildcards), so an unlisted rename fails closed.
const ACTIONS_BY_OPERATION: Record<string, string[]> = {
  's3:HeadBucket': ['s3:ListBucket'],
  's3:ListBuckets': ['s3:ListAllMyBuckets'],
  's3:ListObjectsV2': ['s3:ListBucket'],
  's3:ListObjectVersions': ['s3:ListBucketVersions'],
  's3:PutPublicAccessBlock': ['s3:PutBucketPublicAccessBlock'],
  // deleteBucket passes each version's VersionId.
  's3:DeleteObjects': ['s3:DeleteObject', 's3:DeleteObjectVersion'],
  's3:waitUntilBucketExists': ['s3:ListBucket'],
  // lib-storage uploads in parts and aborts the upload on failure.
  'lib-storage:Upload': ['s3:PutObject', 's3:AbortMultipartUpload'],
  // AWS answers GetCallerIdentity for every principal; it cannot be denied.
  'sts:GetCallerIdentity': [],
  // A role connection's trust policy authorizes it, not a permission policy.
  'sts:AssumeRoleWithWebIdentity': [],
};

// Actions AWS checks as a side effect of another call: the first Spot launch
// in an account creates the Spot service-linked role (RFC 0047 T7).
const IMPLIED_ACTIONS: Record<string, string[]> = {
  'ec2:RunInstances': ['iam:CreateServiceLinkedRole'],
};

// Value imports that send nothing: enums, and the waiter helper whose
// acceptor sends a Command imported on its own.
const SENDS_NOTHING = new Set([
  'InstanceInterruptionBehavior',
  'MarketType',
  'SpotInstanceType',
  'VolumeType',
  'createWaiter',
  'WaiterState',
]);

// Cloudflare R2 speaks S3 through the same SDK, signed with the Cloudflare
// credential at the R2 endpoint, never with the AWS key. The dependency-cruiser
// rules module-ownership:gateways.r2-objects.ts and
// module-ownership:provider-clients.cloudflare.ts keep any other file from importing them.
const R2_FILES = new Set([
  'src/api/services/gateways/cloudflare.ts',
  'src/api/services/gateways/r2-objects.ts',
  'src/api/services/provider-clients/cloudflare.ts',
]);

// Actions are PascalCase; a condition key such as `s3:prefix` is not one.
const IAM_ACTION_LITERAL =
  /^(?:account|ce|ec2|iam|s3|servicequotas|sts):[A-Z*][A-Za-z*]*$/;

/**
 * The SDK operations a file can send, read in one AST pass. Any shape the scan
 * cannot map to an operation (re-exports, dynamic imports, paginators, the
 * aggregated `S3`/`EC2` clients) throws instead of passing unseen.
 */
function scan(file: string, text: string): string[] {
  const found: string[] = [];
  const fail = (why: string) => {
    throw new Error(`${file}: ${why}; send AWS calls as imported Commands`);
  };
  const isSdk = (node: ts.Node | undefined) =>
    node !== undefined &&
    ts.isStringLiteralLike(node) &&
    node.text.startsWith('@aws-sdk/');
  const visit = (node: ts.Node): void => {
    // Belt and braces for the session policy the API mints with the key
    // (s3BucketStatements): its actions must be granted to the key itself.
    if (
      ts.isStringLiteral(node) &&
      file.startsWith('src/api/') &&
      IAM_ACTION_LITERAL.test(node.text)
    )
      found.push(node.text);
    if (ts.isExportDeclaration(node) && isSdk(node.moduleSpecifier))
      fail('re-exports from the AWS SDK');
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require')) &&
      isSdk(node.arguments[0])
    )
      fail('loads the AWS SDK dynamically');
    if (
      ts.isImportDeclaration(node) &&
      isSdk(node.moduleSpecifier) &&
      !node.importClause?.isTypeOnly
    ) {
      const module = (node.moduleSpecifier as ts.StringLiteral).text;
      const bindings = node.importClause?.namedBindings;
      if (node.importClause?.name || !bindings || !ts.isNamedImports(bindings))
        fail(`imports ${module} without names`);
      const pkg = module.slice('@aws-sdk/'.length);
      const prefix = pkg.startsWith('client-')
        ? (PREFIX_RENAMES[pkg] ?? pkg.slice('client-'.length))
        : pkg;
      for (const element of (bindings as ts.NamedImports).elements) {
        const name = (element.propertyName ?? element.name).text;
        if (element.isTypeOnly || SENDS_NOTHING.has(name)) continue;
        if (name.endsWith('Command'))
          found.push(`${prefix}:${name.slice(0, -'Command'.length)}`);
        else if (name.startsWith('waitUntil') || name === 'Upload')
          found.push(`${prefix}:${name}`);
        else if (!name.endsWith('Client'))
          fail(`imports ${name} from ${module}, which the scan cannot map`);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest));
  return found;
}

// The hosted API's self-delete acts as the management VM's own instance
// profile (the seed's role), never as a stored key.
const INSTANCE_IDENTITY_FILES = new Set([
  'src/api/services/gateways/self-delete.ts',
]);

const required = readdirSync('src', { recursive: true, encoding: 'utf8' })
  .filter((path) => path.endsWith('.ts'))
  .map((path) => join('src', path))
  .filter((file) => !R2_FILES.has(file) && !INSTANCE_IDENTITY_FILES.has(file))
  .flatMap((file) => scan(file, readFileSync(file, 'utf8')))
  .flatMap((operation) => ACTIONS_BY_OPERATION[operation] ?? [operation]);
required.push(...required.flatMap((action) => IMPLIED_ACTIONS[action] ?? []));

const allowed = anycloudAccess.Statement.filter(
  (statement) => statement.Effect === 'Allow',
);
const granted = allowed.flatMap((statement) => [statement.Action].flat());

describe('AnycloudAccess policy', () => {
  it('0047 invariant 6 grants exactly the AWS actions Anycloud sends', () => {
    expect([...new Set(granted)].sort()).toEqual([...new Set(required)].sort());
  });

  it.each([
    [`export { S3Client } from '@aws-sdk/client-s3';`, /re-exports/],
    [`const { EC2 } = await import('@aws-sdk/client-ec2');`, /dynamically/],
    [`const sts = require('@aws-sdk/client-sts');`, /dynamically/],
    [`import { paginateListBuckets } from '@aws-sdk/client-s3';`, /cannot map/],
    [`import { S3 } from '@aws-sdk/client-s3';`, /cannot map/],
    [`import * as ec2 from '@aws-sdk/client-ec2';`, /without names/],
  ])('refuses SDK use it cannot map: %s', (source, reason) => {
    expect(() => scan('src/api/probe.ts', source)).toThrow(reason);
  });

  it('allows IAM only to create the Spot service-linked role', () => {
    expect(
      allowed.filter((statement) =>
        [statement.Action].flat().some((action) => action.startsWith('iam:')),
      ),
    ).toEqual([
      {
        Sid: 'SpotServiceLinkedRole',
        Effect: 'Allow',
        Action: 'iam:CreateServiceLinkedRole',
        Resource:
          'arn:aws:iam::*:role/aws-service-role/spot.amazonaws.com/AWSServiceRoleForEC2Spot',
        Condition: {
          StringEquals: { 'iam:AWSServiceName': 'spot.amazonaws.com' },
        },
      },
    ]);
  });

  it('fits the 2,048 characters IAM allows for a user inline policy', () => {
    // IAM does not count whitespace toward the limit.
    expect(
      JSON.stringify(anycloudAccess).replace(/\s/g, '').length,
    ).toBeLessThanOrEqual(2048);
  });
});
