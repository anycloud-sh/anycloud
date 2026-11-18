import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { CI_RESOURCE_SWEEP_POLICY } from '../../../ci/cleanup/policy';
import {
  TEST_USER_ID,
  TEST_USERNAMES,
} from '../../../src/api/services/test-identity';

const root = join(__dirname, '../../integration');
const OWNERS: Record<string, string> = {
  'TEST_USERNAMES[0]': TEST_USERNAMES[0],
  TEST_USER_ID,
};

/** Each bucket an integration spec creates, with the user it tags as owner. */
function bucketOwners(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(join(root, file), 'utf8'),
    ts.ScriptTarget.Latest,
  );
  const constants = new Map<string, ts.Expression>();
  const owners: string[] = [];
  const resolve = (node: ts.Expression): string => {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node) && constants.has(node.text))
      return resolve(constants.get(node.text)!);
    return OWNERS[node.getText(source)] ?? node.getText(source);
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    )
      constants.set(node.name.text, node.initializer);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['upsertBucket', 'createOwnedBucket'].includes(
        node.expression.name.text,
      ) &&
      node.arguments[3]
    )
      owners.push(resolve(node.arguments[3]));
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return owners;
}

it('tags every integration bucket with a user the CI sweep reclaims', () => {
  // A cancelled run skips afterAll, so only the sweep removes its buckets.
  const owners = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .flatMap((file) => bucketOwners(file).map((owner) => `${file}: ${owner}`));
  expect(owners).not.toEqual([]);
  expect(
    owners.filter(
      (entry) =>
        !CI_RESOURCE_SWEEP_POLICY.reclaimableUserIds.some((id) =>
          entry.endsWith(`: ${id}`),
        ),
    ),
  ).toEqual([]);
});
