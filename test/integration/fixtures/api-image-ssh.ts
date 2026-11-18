import assert from 'node:assert/strict';
import { chmodSync, readdirSync, statSync } from 'node:fs';

// Mounted into the final image; exercise its built production transport.
const gateway = 'file:///app/dist/api/services/gateways/ssh.js';
const ssh = (await import(
  gateway
)) as typeof import('../../../src/api/services/gateways/ssh.js');

if (process.argv[2] === 'missing') {
  await assert.rejects(
    () => ssh.SSHManager.generateKeypair(),
    /OpenSSH runtime tmpfs is missing/u,
  );
} else if (process.argv[2] === 'permissive-tmpfs') {
  const directory = ssh.sshRuntimeDirectory();
  assert.equal(statSync(directory).uid, 0);
  assert.equal(statSync(directory).mode & 0o777, 0o777);
  await assert.rejects(
    () => ssh.SSHManager.generateKeypair(),
    /OpenSSH runtime directory must be root-owned and mode 0700/u,
  );
  assert.equal(readdirSync(directory).length, 0);
  // The chart's init container applies this mode before the API starts.
  chmodSync(directory, 0o700);
  const pair = await ssh.SSHManager.generateKeypair();
  assert.equal(
    await ssh.SSHManager.derivePublicKey(pair.privateKey),
    pair.publicKey,
  );
  assert.equal(readdirSync(directory).length, 0);
  console.log('Kubernetes-style tmpfs rejects key generation until mode 0700');
} else {
  assert.equal(process.argv[2], 'tmpfs');
  const directory = ssh.sshRuntimeDirectory();
  const generated = await Promise.allSettled(
    Array.from({ length: 300 }, () => ssh.SSHManager.generateKeypair()),
  );
  const pairs = generated.map((result) => {
    assert.equal(
      result.status,
      'fulfilled',
      'Concurrent SSH generation failed',
    );
    return result.value;
  });
  assert.equal(
    new Set(pairs.map((pair) => pair.publicKey)).size,
    pairs.length,
    'SSH generation reused a key',
  );
  assert.equal(readdirSync(directory).length, 0);
  const derived = await Promise.allSettled(
    pairs.map((pair) => ssh.SSHManager.derivePublicKey(pair.privateKey)),
  );
  for (const [index, result] of derived.entries()) {
    assert.equal(
      result.status,
      'fulfilled',
      'Concurrent SSH derivation failed',
    );
    assert.equal(result.value, pairs[index]?.publicKey);
  }
  assert.equal(readdirSync(directory).length, 0);
  const invalid = await Promise.allSettled(
    Array.from({ length: 64 }, () =>
      ssh.SSHManager.derivePublicKey('not-a-key'),
    ),
  );
  for (const result of invalid) {
    assert.equal(result.status, 'rejected');
    assert.ok(
      result.reason instanceof Error &&
        result.reason.message.includes('Failed to parse SSH private key'),
    );
  }
  assert.equal(readdirSync(directory).length, 0);
  const recovered = await ssh.SSHManager.generateKeypair();
  assert.equal(
    await ssh.SSHManager.derivePublicKey(recovered.privateKey),
    recovered.publicKey,
  );
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(readdirSync(directory).length, 0);
  console.log(
    JSON.stringify({
      generated: pairs.length,
      derived: derived.length,
      rejectedInvalidKeys: invalid.length,
      recovered: true,
      remainingFiles: 0,
    }),
  );
}
