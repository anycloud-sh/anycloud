import { describe, expect, it } from 'vitest';
import { runScriptInTree } from '../../helpers/run-script-in-tree.mjs';

const check = (files) =>
  runScriptInTree('scripts/check-api-contract-boundaries.mjs', files);

describe('API contract boundary check', () => {
  it('accepts contracts, procedures, domains, and clients on their own side', () => {
    const result = check({
      'src/shared/api-contract/base.ts': "import { oc } from '@orpc/contract';",
      'src/shared/api-contract/jobs.ts': "import { query } from './base.js';",
      'src/shared/api-contract/job-schemas.ts': "import { z } from 'zod';",
      'src/api/rpc/jobs.ts':
        "import { os } from '@orpc/server';\nimport { listJobs } from '../services/jobs-domain.js';",
      'src/api/services/jobs-domain.ts':
        "import { getDB } from '../db.js';\nexport const listJobs = () => getDB();",
      'src/shared/services/api-client/rpc.ts':
        "import { createORPCClient } from '@orpc/client';",
      'src/cli/commands/status.ts':
        "await fetch('https://example.com/health');",
      // A cloud's own REST API is not Anycloud's control plane.
      'src/cli/seed/accounts.ts':
        'await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${id}:testIamPermissions`, {});\nawait fetch(`${resourceManagerEndpoint()}/v1/projects/${id}:testIamPermissions`, {});',
    });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it.each([
    [
      'src/shared/api-contract/jobs.ts',
      "import { oc } from '@orpc/contract';",
      'query/command endpoint builders forbids import/use @orpc/contract',
    ],
    [
      'src/shared/api-contract/jobs.ts',
      "import express from 'express';",
      'shared contract isolation forbids import/use express',
    ],
    [
      'src/shared/api-contract/jobs.ts',
      "import { store } from '../../api/repositories/jobs.js';",
      'shared contract isolation forbids import/use ../../api/repositories/jobs.js',
    ],
    [
      'src/shared/api-contract/job-schemas.ts',
      "import { type } from '@orpc/client';",
      'transport-free schemas forbids import/use @orpc/client',
    ],
    [
      'src/api/rpc/jobs.ts',
      "import { gateway } from '../gateways/aws.js';",
      'thin RPC procedures forbids import/use ../gateways/aws.js',
    ],
    [
      'src/api/rpc/jobs.ts',
      'const rows = getDB().select();',
      'thin RPC procedures forbids import/use getDB()',
    ],
    [
      'src/api/rpc/jobs.ts',
      "import { auth } from '../middleware/auth.js';",
      'transport-independent RPC procedures forbids import/use ../middleware/auth.js',
    ],
    [
      'src/api/services/jobs-domain.ts',
      "import { ORPCError } from '@orpc/server';",
      'transport-free domain forbids import/use @orpc/server',
    ],
    [
      'src/shared/services/api-client/rpc.ts',
      "import { os } from '@orpc/server';",
      'client/server separation forbids import/use @orpc/server',
    ],
    [
      'src/shared/services/api-client/rpc.ts',
      "import { log } from '../../cli/log.js';",
      'acyclic client infrastructure forbids import/use ../../cli/log.js',
    ],
    [
      'src/cli/commands/jobs.ts',
      "import { client } from '../../shared/services/api-client.js';",
      'contract-derived client ownership forbids import/use ../../shared/services/api-client.js',
    ],
    [
      'src/cli/commands/jobs.ts',
      'await fetch(`${apiUrl}/v1/jobs`);',
      'typed JSON control-plane client forbids import/use fetch(.../v1/...)',
    ],
    [
      'src/cli/commands/clusters.ts',
      "await fetch('https://abc.anycloud.sh/v1/clusters');",
      'typed JSON control-plane client forbids import/use fetch(.../v1/...)',
    ],
    [
      'src/cli/commands/clusters.ts',
      'await fetch(`${apiEndpoint()}/v1/clusters`);',
      'typed JSON control-plane client forbids import/use fetch(.../v1/...)',
    ],
  ])(
    'rejects %s importing across its boundary: %s',
    (path, source, message) => {
      const result = check({ [path]: source });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${path}: ${message}`);
    },
  );

  it('rejects reintroducing the legacy client facade', () => {
    const result = check({ 'src/shared/services/api-client.ts': '' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'src/shared/services/api-client.ts: contract-derived client ownership forbids import/use legacy API client facade',
    );
  });
});
