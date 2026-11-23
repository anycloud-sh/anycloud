import { readFileSync } from 'node:fs';
import { loadYaml } from '@kubernetes/client-node';
import { describe, expect, it } from 'vitest';

import anycloudRole from '../../../src/shared/cloud-policies/gcp-anycloud-role.json' with { type: 'json' };
import ciRole from '../../../ci/gcp-ci-role.json' with { type: 'json' };
import { bindCIRoles } from '../../../ci/gcp-roles';
import {
  GCPBootstrapError,
  type GCPTransport,
} from '../../../src/cli/services/credential-bootstrap/gcp-transport';

const projectId = 'ci-project';
const email = `anycloud-ci-gcp@${projectId}.iam.gserviceaccount.com`;
const product = `projects/${projectId}/roles/anycloud`;
const ci = `projects/${projectId}/roles/anycloud_ci`;
const member = `serviceAccount:${email}`;
const documents = {
  [product]: anycloudRole.includedPermissions,
  [ci]: ciRole.includedPermissions,
};

interface Binding {
  role: string;
  members: string[];
  condition?: unknown;
}

function fakeProject(state: {
  roles: Record<string, string[]>;
  bindings: Binding[];
  conflicts?: number;
  /** Reads before a new binding takes effect. */
  lag?: number;
}) {
  const writes: string[] = [];
  let etag = 1;
  const transport: GCPTransport = {
    async request(service, path, method = 'GET', body) {
      const call = `${service} ${method} ${path.replace(/\?.*/u, '')}`;
      const name = path.slice(4).replace(/\?.*/u, '');
      if (service === 'iam' && method === 'GET') {
        if (!state.roles[name])
          throw new GCPBootstrapError('', 404, 'NOT_FOUND');
        return { includedPermissions: state.roles[name], etag: 'r' };
      }
      if (call === `iam POST /v1/projects/${projectId}/roles`) {
        const { roleId, role } = body as {
          roleId: string;
          role: { includedPermissions: string[] };
        };
        writes.push(`create ${roleId}`);
        state.roles[`projects/${projectId}/roles/${roleId}`] =
          role.includedPermissions;
        return {};
      }
      if (service === 'iam' && method === 'PATCH') {
        writes.push(`update ${name.split('/').pop()}`);
        state.roles[name] = (
          body as { includedPermissions: string[] }
        ).includedPermissions;
        return {};
      }
      if (call === `projects POST /v1/projects/${projectId}:getIamPolicy`)
        return structuredClone({ etag: `p${etag}`, bindings: state.bindings });
      if (call === `projects POST /v1/projects/${projectId}:setIamPolicy`) {
        const policy = (body as { policy: { etag: string; bindings: [] } })
          .policy;
        if (state.conflicts) {
          state.conflicts -= 1;
          etag += 1;
          throw new GCPBootstrapError('', 409, 'ABORTED');
        }
        if (policy.etag !== `p${etag}`)
          throw new Error('setIamPolicy without a fresh etag');
        writes.push('bind');
        state.bindings = policy.bindings;
        etag += 1;
        return {};
      }
      if (
        call === `projects POST /v1/projects/${projectId}:testIamPermissions`
      ) {
        const granted = state.bindings
          .filter((b) => !b.condition && b.members.includes(member))
          .flatMap((b) => state.roles[b.role] ?? []);
        if (granted.length && state.lag) state.lag -= 1;
        return {
          permissions: (body as { permissions: string[] }).permissions.filter(
            (p) => !state.lag && granted.includes(p),
          ),
        };
      }
      throw new Error(`unexpected ${call}`);
    },
  };
  return { transport, writes };
}

describe("CI's GCP account on the published Anycloud role and CI's own role", () => {
  it('creates both roles and binds the account without touching other bindings', async () => {
    const other = { role: 'roles/iam.roleAdmin', members: [member] };
    const state = { roles: {}, bindings: [other] };
    const { transport, writes } = fakeProject(state);
    await bindCIRoles(transport, projectId, email);
    expect(writes).toEqual(['create anycloud', 'create anycloud_ci', 'bind']);
    expect(state.roles).toEqual(documents);
    expect(state.bindings).toEqual([
      other,
      { role: product, members: [member] },
      { role: ci, members: [member] },
    ]);
  });

  it('adds missing permissions and joins existing unconditioned bindings', async () => {
    const conditioned = {
      role: product,
      members: [member],
      condition: { title: 'later', expression: 'false' },
    };
    const state = {
      roles: {
        [product]: ['compute.instances.get', 'compute.instances.reset'],
        [ci]: ciRole.includedPermissions,
      },
      bindings: [
        conditioned,
        { role: product, members: ['user:someone@example.com'] },
        { role: ci, members: [member] },
      ],
    };
    const { transport, writes } = fakeProject(state);
    await bindCIRoles(transport, projectId, email);
    expect(writes).toEqual(['update anycloud', 'bind']);
    // Add-only: a permission another branch published stays.
    expect(new Set(state.roles[product])).toEqual(
      new Set([...anycloudRole.includedPermissions, 'compute.instances.reset']),
    );
    expect(state.bindings).toEqual([
      conditioned,
      { role: product, members: ['user:someone@example.com', member] },
      { role: ci, members: [member] },
    ]);
  });

  it('writes nothing when the roles match and the account is bound', async () => {
    const { transport, writes } = fakeProject({
      roles: { ...documents },
      bindings: [
        { role: product, members: [member] },
        { role: ci, members: [member] },
      ],
    });
    await bindCIRoles(transport, projectId, email);
    expect(writes).toEqual([]);
  });

  it("rereads the policy when a parallel member's write wins", async () => {
    const state = { roles: { ...documents }, bindings: [], conflicts: 2 };
    const { transport, writes } = fakeProject(state);
    await bindCIRoles(transport, projectId, email);
    expect(writes).toEqual(['bind']);
    expect(state.bindings).toEqual([
      { role: product, members: [member] },
      { role: ci, members: [member] },
    ]);
  });

  it("keeps the product's permissions out of CI's own role", () => {
    expect(
      ciRole.includedPermissions.filter((p) =>
        anycloudRole.includedPermissions.includes(p),
      ),
    ).toEqual([]);
  });

  it('returns once the bindings take effect', async () => {
    const state = { roles: { ...documents }, bindings: [], lag: 2 };
    const { transport } = fakeProject(state);
    await bindCIRoles(transport, projectId, email);
    expect(state.lag).toBe(0);
  });
});

describe('workflows bind the roles before GCP members run', () => {
  it.each([
    ['e2e-job.yml', 'e2e-job-vitest'],
    ['e2e-cluster-cloud.yml', 'e2e-cluster-cloud'],
  ])('%s', (file, job) => {
    const steps = (
      loadYaml(readFileSync(`.github/workflows/${file}`, 'utf8')) as {
        jobs: Record<string, { steps: Array<{ id?: string; run?: string }> }>;
      }
    ).jobs[job].steps;
    const bind = steps.findIndex((step) =>
      step.run?.includes('npx tsx ci/gcp-roles.ts'),
    );
    expect(bind).toBeGreaterThan(-1);
    expect(bind).toBeLessThan(steps.findIndex((step) => step.id === 'tests'));
  });
});
