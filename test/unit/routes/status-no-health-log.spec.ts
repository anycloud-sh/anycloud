import { describe, it, expect, beforeEach, vi } from 'vitest';
import { callApi } from '../helpers/api-test-helper';
import { TEST_DAEMON_VERSION } from '../config';
import { walkToState, provisionTestVm } from '../../helpers/workload-store.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import { ContainerState, ServiceState } from '../../../src/shared/runtime.js';
import { log } from '../../../src/api/services/logger';
import { resetTestStore } from '../utils';
import { CloudType } from '../../../src/shared/cloud.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';
import { getDB } from '../../../src/api/services/repositories/db.js';

// Isolated from status.spec.ts: the SSH transport seam is faked so the health
// check runs against scripted command output instead of an unreachable IP
// (which would just throw and yield status '-'). Mocking createTransport (not
// the ssh module) covers BOTH DockerManager and SupervisorManager, since each
// builds its VmTransport via createTransport(). This drives the VM-host
// operations adapter down the AWS path: docker inspect + rclone systemd probe.
const { fake } = await vi.hoisted(async () => {
  const { createFakeTransport } = await import('../helpers/mock-transport');
  return { fake: createFakeTransport() };
});
vi.mock('../../../src/api/services/gateways/transport', () => ({
  createTransport: vi.fn(() => fake),
}));

const id = 'status-unhealthy-no-log';

describe('Status endpoint — unhealthy workload does not flood API logs', () => {
  beforeEach(async () => {
    fake.reset();
    await resetTestStore();
  });

  it('surfaces the unhealthy container/rclone in the body but never log.errors it', async () => {
    // systemd present -> SupervisorManager.getStatus uses the systemctl branch.
    fake.on('ps -p 1 -o comm=', { stdout: 'systemd\n', code: 0 });
    // Unhealthy, non-clean exit: exited with code 1 (not the exit-0 success case).
    fake.on('docker inspect', {
      stdout: JSON.stringify({
        Status: ContainerState.Exited,
        ExitCode: 1,
        StartedAt: '2024-01-01T00:00:00Z',
        OOMKilled: false,
        Error: '',
      }),
      code: 0,
    });
    // getContainerStatus pulls logs for non-running containers.
    fake.on('docker logs', { stdout: 'boom: process crashed\n', code: 0 });
    // rclone output service in error -> ServiceState.Fatal (the removed code
    // logged 'Rclone output sync not running' for exactly this).
    fake.on('systemctl is-active rclone-output', {
      stdout: 'failed\n',
      code: 0,
    });
    fake.on('systemctl is-active rclone-checkpoint', {
      stdout: 'unknown\n',
      code: 0,
    });
    // Logs fetched for the failed/non-running service.
    fake.on('journalctl', { stdout: 'rclone: permission denied\n', code: 0 });
    fake.default({ stdout: '', stderr: '', code: 0 });

    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'test-image',
      outputBucket: 'my-output-bucket',
      dockerCommand: 'docker run -d --name test test-image',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-credential-id',
    });
    await provisionTestVm(id, {
      ip: '10.0.0.7',
      cloudId: 'vm-unhealthy',
      privateIp: '192.168.0.7',
    });
    await walkToState(id, WorkloadState.Running);

    const errorSpy = vi.spyOn(log, 'error');

    const response = await callApi(`https://example.com/v1/workloads/${id}`, {
      headers: { Authorization: 'Bearer mock-github-token' },
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    // The unhealthy data IS still surfaced to the inspecting user.
    expect(body.status).toBe('down');
    const liveVm = body.vms.find((vm: { ip: string }) => vm.ip === '10.0.0.7');
    expect(liveVm).toBeDefined();
    expect(liveVm.container.state).toBe(ContainerState.Exited);
    expect(liveVm.container.exitCode).toBe(1);
    expect(liveVm.rclone.output.status).toBe(ServiceState.Fatal);

    // ...but inspecting a workload via status must NOT emit ERROR-level logs
    // for the unhealthy container / rclone services (the regression this guards).
    expect(errorSpy).not.toHaveBeenCalledWith(
      'Container unhealthy',
      expect.anything(),
    );
    expect(errorSpy).not.toHaveBeenCalledWith(
      'Rclone output sync not running',
      expect.anything(),
    );
    expect(errorSpy).not.toHaveBeenCalledWith(
      'Rclone output sync has errors',
      expect.anything(),
    );
    expect(errorSpy).not.toHaveBeenCalledWith(
      'Rclone checkpoint sync not running',
      expect.anything(),
    );

    errorSpy.mockRestore();
  });

  it('does not expose internal container startedAt in status responses', async () => {
    const runningId = 'status-running-no-started-at';

    fake.on('ps -p 1 -o comm=', { stdout: 'systemd\n', code: 0 });
    fake.on('docker inspect', {
      stdout: JSON.stringify({
        Status: ContainerState.Running,
        ExitCode: 0,
        StartedAt: '2024-01-01T00:00:00Z',
        OOMKilled: false,
        Error: '',
      }),
      code: 0,
    });
    fake.on('systemctl is-active rclone-output', {
      stdout: 'unknown\n',
      code: 0,
    });
    fake.on('systemctl is-active rclone-checkpoint', {
      stdout: 'unknown\n',
      code: 0,
    });
    fake.default({ stdout: '', stderr: '', code: 0 });

    await createWorkload(getDB(), {
      id: runningId,
      userId: 'test-user',
      workloadType: 'job',
      image: 'test-image',
      dockerCommand: 'docker run -d --name test test-image',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-credential-id',
    });
    await provisionTestVm(runningId, {
      ip: '10.0.0.8',
      cloudId: 'vm-running',
      privateIp: '192.168.0.8',
    });
    await walkToState(runningId, WorkloadState.Running);

    const response = await callApi(
      `https://example.com/v1/workloads/${runningId}`,
      { headers: { Authorization: 'Bearer mock-github-token' } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    const liveVm = body.vms.find((vm: { ip: string }) => vm.ip === '10.0.0.8');

    expect(body.status).toBe('up');
    expect(liveVm.container.state).toBe(ContainerState.Running);
    expect(liveVm.container.uptime).toBeDefined();
    expect('startedAt' in liveVm.container).toBe(false);
    expect(JSON.stringify(liveVm.container)).not.toContain('startedAt');
  });
});
