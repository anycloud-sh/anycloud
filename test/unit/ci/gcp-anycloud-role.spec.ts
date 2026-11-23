import { readFileSync } from 'node:fs';
import { loadYaml } from '@kubernetes/client-node';
import { describe, expect, it } from 'vitest';

import anycloudRole from '../../../src/shared/cloud-policies/gcp-anycloud-role.json' with { type: 'json' };
import { bindAnycloudRole } from '../../../ci/gcp-anycloud-role';
import {
  GCPBootstrapError,
  type GCPTransport,
} from '../../../src/cli/services/credential-bootstrap/gcp-transport';

const projectId = 'ci-project';
const email = `anycloud-ci-gcp@${projectId}.iam.gserviceaccount.com`;
const role = `projects/${projectId}/roles/anycloud`;
const member = `serviceAccount:${email}`;

function fakeProject(state: {
  role?: { includedPermissions: string[]; etag: string };
  bindings: Array<{ role: string; members: string[]; condition?: unknown }>;
  conflicts?: number;
  /** Reads before a new binding takes effect. */
  lag?: number;
}) {
  const writes: string[] = [];
  let etag = 1;
  const transport: GCPTransport = {
    async request(service, path, method = 'GET', body) {
      const call = `${service} ${method} ${path}`;
      if (call === `iam GET /v1/${role}`) {
        if (!state.role) throw new GCPBootstrapError('', 404, 'NOT_FOUND');
        return state.role;
      }
      if (call === `iam POST /v1/projects/${projectId}/roles`) {
        writes.push('create role');
        state.role = {
          includedPermissions: (body as { role: typeof anycloudRole }).role
            .includedPermissions,
          etag: 'r1',
        };
        return state.role;
      }
      if (call === `iam PATCH /v1/${role}?updateMask=includedPermissions`) {
        writes.push('update role');
        state.role = {
          ...(body as { includedPermissions: string[] }),
          etag: 'r2',
        };
        return state.role;
      }
      if (call === `projects POST /v1/projects/${projectId}:getIamPolicy`)
        return structuredClone({ etag: `p${etag}`, bindings: state.bindings });
      if (call === `projects POST /v1/projects/${projectId}:setIamPolicy`) {
        const policy = (body as { policy: typeof state & { etag: string } })
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
        return { etag: `p${etag}`, bindings: state.bindings };
      }
      if (
        call === `projects POST /v1/projects/${projectId}:testIamPermissions`
      ) {
        const bound = state.bindings.some(
          (b) => b.role === role && !b.condition && b.members.includes(member),
        );
        if (bound && state.lag) state.lag -= 1;
        const granted =
          bound && !state.lag ? state.role!.includedPermissions : [];
        return {
          permissions: (body as { permissions: string[] }).permissions.filter(
            (p) => granted.includes(p),
          ),
        };
      }
      throw new Error(`unexpected ${call}`);
    },
  };
  return { transport, writes };
}

describe("CI's GCP identity on the published Anycloud role", () => {
  it('creates the role and binds the account without touching other bindings', async () => {
    const other = { role: 'roles/iam.roleAdmin', members: [member] };
    const state = { bindings: [other] };
    const { transport, writes } = fakeProject(state);
    await bindAnycloudRole(transport, projectId, email);
    expect(writes).toEqual(['create role', 'bind']);
    expect(state.bindings).toEqual([other, { role, members: [member] }]);
  });

  it('adds missing published permissions and joins an existing binding', async () => {
    const conditioned = {
      role,
      members: [member],
      condition: { title: 'later', expression: 'false' },
    };
    const state = {
      role: { includedPermissions: ['compute.instances.get'], etag: 'r0' },
      bindings: [conditioned, { role, members: ['user:someone@example.com'] }],
    };
    const { transport, writes } = fakeProject(state);
    await bindAnycloudRole(transport, projectId, email);
    expect(writes).toEqual(['update role', 'bind']);
    expect([...state.role.includedPermissions].sort()).toEqual(
      [...anycloudRole.includedPermissions].sort(),
    );
    expect(state.bindings).toEqual([
      conditioned,
      { role, members: ['user:someone@example.com', member] },
    ]);
  });

  it('writes nothing when the role matches and the account is bound', async () => {
    const { transport, writes } = fakeProject({
      role: {
        includedPermissions: anycloudRole.includedPermissions,
        etag: 'r0',
      },
      bindings: [{ role, members: [member] }],
    });
    await bindAnycloudRole(transport, projectId, email);
    expect(writes).toEqual([]);
  });

  it("rereads the policy when a parallel member's write wins", async () => {
    const state = {
      role: {
        includedPermissions: anycloudRole.includedPermissions,
        etag: 'r0',
      },
      bindings: [],
      conflicts: 2,
    };
    const { transport, writes } = fakeProject(state);
    await bindAnycloudRole(transport, projectId, email);
    expect(writes).toEqual(['bind']);
    expect(state.bindings).toEqual([{ role, members: [member] }]);
  });
  it('returns once the binding takes effect', async () => {
    const state = {
      role: {
        includedPermissions: anycloudRole.includedPermissions,
        etag: 'r0',
      },
      bindings: [],
      lag: 2,
    };
    const { transport } = fakeProject(state);
    await bindAnycloudRole(transport, projectId, email);
    expect(state.lag).toBe(0);
  });
});

describe('workflows bind the role before GCP members run', () => {
  const steps = (file: string, job: string) =>
    (
      loadYaml(readFileSync(`.github/workflows/${file}`, 'utf8')) as {
        jobs: Record<
          string,
          { steps: Array<{ name?: string; if?: string; run?: string }> }
        >;
      }
    ).jobs[job].steps;

  it.each([
    ['e2e-job.yml', 'e2e-job-vitest', 'tests'],
    ['e2e-cluster-cloud.yml', 'e2e-cluster-cloud', 'tests'],
  ])('%s', (file, job, testsId) => {
    const all = steps(file, job) as Array<{ id?: string; run?: string }>;
    const bind = all.findIndex((step) =>
      step.run?.includes('npx tsx ci/gcp-anycloud-role.ts'),
    );
    expect(bind).toBeGreaterThan(-1);
    expect(bind).toBeLessThan(all.findIndex((step) => step.id === testsId));
  });
});
