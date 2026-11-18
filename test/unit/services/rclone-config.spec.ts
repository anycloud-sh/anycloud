import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  RCLONE_CONF_TEMPLATE,
  rcloneEnvVars,
  rcloneTokenConfig,
  rcloneGrantRemote,
  rcloneCopyCommand,
  rcloneContinuousLoop,
  rcloneInputSyncCommand,
  getRemotePath,
} from '../../../src/api/services/rclone-config';
import { CloudType } from '../../../src/shared/cloud.js';

describe('rclone-config', () => {
  describe('RCLONE_CONF_TEMPLATE', () => {
    it('reads Azure and S3 credentials from the environment and never a GCP VM identity', () => {
      const remote = (name: string) =>
        RCLONE_CONF_TEMPLATE.split('\n\n').find((section) =>
          section.startsWith(`[${name}]`),
        );
      expect(remote('azureblob')).toContain('env_auth = true');
      expect(remote('s3')).toContain('env_auth = true');
      expect(remote('gcs')).not.toContain('env_auth');
    });
    it('declares one R2 remote with no endpoint, so each bucket names its account', () => {
      const r2 = RCLONE_CONF_TEMPLATE.slice(
        RCLONE_CONF_TEMPLATE.indexOf('[r2]'),
      );
      expect(r2).toMatch(/provider = Cloudflare[\s\S]*env_auth = true/);
      expect(r2).not.toMatch(/endpoint =/);
    });
    it('omits explicit Azure account so per-bucket env can target different accounts', () => {
      // Regression: if `account = ...` reappears under [azureblob], the
      // VM-host per-bucket env file no longer overrides it.
      expect(RCLONE_CONF_TEMPLATE).not.toMatch(/\[azureblob\][\s\S]*account =/);
    });
  });

  describe('rcloneEnvVars', () => {
    it('sends a minted R2 token and its account endpoint for a Cloudflare bucket', () => {
      expect(
        rcloneEnvVars({
          name: 'r2-bucket',
          cloudType: CloudType.Cloudflare,
          endpoint: 'https://acct.eu.r2.cloudflarestorage.com',
          credentials: {
            cloudProvider: CloudType.AWS,
            accessKeyId: 'temp-key',
            secretAccessKey: 'temp-secret',
            sessionToken: 'temp-session',
          },
        }),
      ).toEqual({
        RCLONE_CONFIG_R2_ENDPOINT: 'https://acct.eu.r2.cloudflarestorage.com',
        AWS_ACCESS_KEY_ID: 'temp-key',
        AWS_SECRET_ACCESS_KEY: 'temp-secret',
        AWS_SESSION_TOKEN: 'temp-session',
      });
    });

    it('emits AWS_* for AWS credentials', () => {
      const env = rcloneEnvVars({
        name: 'my-bucket',
        cloudType: CloudType.AWS,
        credentials: {
          cloudProvider: CloudType.AWS,
          accessKeyId: 'AKIA-test',
          secretAccessKey: 'secret-test',
        },
      });
      expect(env).toEqual({
        AWS_ACCESS_KEY_ID: 'AKIA-test',
        AWS_SECRET_ACCESS_KEY: 'secret-test',
      });
    });

    it('emits AWS_SESSION_TOKEN for minted (short-lived) AWS credentials', () => {
      const env = rcloneEnvVars({
        name: 'my-bucket',
        cloudType: CloudType.AWS,
        credentials: {
          cloudProvider: CloudType.AWS,
          accessKeyId: 'ASIA-test',
          secretAccessKey: 'secret-test',
          sessionToken: 'session-token-test',
        },
      });
      expect(env).toEqual({
        AWS_ACCESS_KEY_ID: 'ASIA-test',
        AWS_SECRET_ACCESS_KEY: 'secret-test',
        AWS_SESSION_TOKEN: 'session-token-test',
      });
    });

    it('emits the AWS S3 region for same-cloud bucket sync', () => {
      const env = rcloneEnvVars({
        name: 'my-bucket',
        cloudType: CloudType.AWS,
        region: 'us-east-1',
      });
      expect(env).toEqual({
        RCLONE_CONFIG_S3_REGION: 'us-east-1',
      });
    });

    it('keeps AWS bucket regions independent across input, output, and checkpoint configs', () => {
      const input = rcloneEnvVars({
        name: 'input-bucket',
        cloudType: CloudType.AWS,
        region: 'us-east-1',
      });
      const output = rcloneEnvVars({
        name: 'output-bucket',
        cloudType: CloudType.AWS,
        region: 'us-west-2',
      });
      const checkpoint = rcloneEnvVars({
        name: 'checkpoint-bucket',
        cloudType: CloudType.AWS,
        region: 'eu-west-1',
      });

      expect(input.RCLONE_CONFIG_S3_REGION).toBe('us-east-1');
      expect(output.RCLONE_CONFIG_S3_REGION).toBe('us-west-2');
      expect(checkpoint.RCLONE_CONFIG_S3_REGION).toBe('eu-west-1');
    });

    it('0047/S11 puts a minted GCP token in a config file rclone reloads, never in the env', () => {
      // rclone re-reads an expired oauth token through its config map, where
      // the environment shadows the file; only a file can be renewed.
      const config = {
        name: 'my-bucket',
        cloudType: CloudType.GCP,
        credentials: {
          cloudProvider: CloudType.GCP,
          accessToken: 'downscoped',
        },
        // Go's RFC3339, whole seconds, so rclone re-serializes it unchanged.
        credentialExpiresAt: Date.UTC(2026, 9, 9, 12) + 999,
      } as const;
      expect(rcloneEnvVars(config)).toEqual({});
      const token = JSON.stringify({
        access_token: 'downscoped',
        token_type: 'Bearer',
        expiry: '2026-10-09T12:00:00Z',
      });
      expect(rcloneTokenConfig(config)).toBe(
        `[gcs]\ntype = google cloud storage\nbucket_policy_only = true\nno_check_bucket = true\ntoken = ${token}\n`,
      );
    });

    it('needs no token config for S3, Azure or an unminted bucket', () => {
      expect(
        rcloneTokenConfig({ name: 'b', cloudType: CloudType.AWS }),
      ).toBeUndefined();
    });

    it('returns just the Azure storage account when no token is present', () => {
      const env = rcloneEnvVars({
        name: 'my-bucket',
        cloudType: CloudType.Azure,
        storageAccountName: 'mystorage',
      });
      expect(env).toEqual({
        AZURE_STORAGE_ACCOUNT: 'mystorage',
        RCLONE_CONFIG_AZUREBLOB_ACCOUNT: 'mystorage',
      });
    });

    it('0047/S11 points rclone at a minted container SAS instead of the VM identity', () => {
      const sasToken = 'sv=2025-01-05&sr=c&sp=racwdl&sig=abc%2B';
      expect(
        rcloneEnvVars({
          name: 'results',
          cloudType: CloudType.Azure,
          storageAccountName: 'mystorage',
          credentials: { cloudProvider: CloudType.Azure, sasToken },
        }),
      ).toEqual({
        AZURE_STORAGE_ACCOUNT: 'mystorage',
        RCLONE_CONFIG_AZUREBLOB_ACCOUNT: 'mystorage',
        // rclone checks env_auth before sas_url, so the conf's env_auth = true
        // must be overridden for the SAS to be used.
        RCLONE_CONFIG_AZUREBLOB_ENV_AUTH: 'false',
        RCLONE_CONFIG_AZUREBLOB_SAS_URL: `https://mystorage.blob.core.windows.net/results?${sasToken}`,
      });
    });

    it('returns empty for a bucket with no creds and no Azure account', () => {
      expect(rcloneEnvVars({ name: 'b', cloudType: CloudType.AWS })).toEqual(
        {},
      );
    });
  });

  describe('rcloneGrantRemote', () => {
    it("0043/S17 configures an S3 or GCS grant's remote from its env alone, the GCS token as rcloneTokenConfig writes it", () => {
      const s3 = rcloneGrantRemote(
        {
          name: 'results',
          cloudType: CloudType.AWS,
          region: 'us-east-2',
          credentials: {
            cloudProvider: CloudType.AWS,
            accessKeyId: 'ASIA',
            secretAccessKey: 's',
            sessionToken: 't',
          },
        },
        'job-a/',
      );
      expect(s3).toEqual({
        remote: 's3:results/job-a/',
        env: expect.objectContaining({
          RCLONE_CONFIG_S3_TYPE: 's3',
          RCLONE_CONFIG_S3_ENV_AUTH: 'true',
          RCLONE_CONFIG_S3_REGION: 'us-east-2',
          AWS_SESSION_TOKEN: 't',
        }),
      });
      const gcs: Parameters<typeof rcloneGrantRemote>[0] = {
        name: 'dataset',
        cloudType: CloudType.GCP,
        credentials: { cloudProvider: CloudType.GCP, accessToken: 'ya29' },
        credentialExpiresAt: Date.UTC(2026, 9, 23, 12),
      };
      const { remote, env } = rcloneGrantRemote(gcs);
      expect(remote).toBe('gcs:dataset/');
      expect(rcloneTokenConfig(gcs)).toContain(
        `token = ${env.RCLONE_CONFIG_GCS_TOKEN}\n`,
      );
      expect(JSON.parse(env.RCLONE_CONFIG_GCS_TOKEN!)).toEqual({
        access_token: 'ya29',
        token_type: 'Bearer',
        expiry: '2026-10-23T12:00:00Z',
      });
    });
  });

  describe('rcloneCopyCommand', () => {
    it("uses rclone copy (not sync) so multi-job shared buckets don't mutually delete", () => {
      const cmd = rcloneCopyCommand('s3:my-bucket', '/mnt/output');
      expect(cmd).toContain('rclone copy /mnt/output s3:my-bucket');
      expect(cmd).not.toContain('rclone sync');
    });

    it('allows callers to override the rclone binary path', () => {
      const cmd = rcloneCopyCommand(
        's3:my-bucket',
        '/mnt/output',
        '/usr/local/bin/rclone',
      );
      expect(cmd).toContain(
        '/usr/local/bin/rclone copy /mnt/output s3:my-bucket',
      );
    });
  });

  describe('rcloneContinuousLoop', () => {
    // Execute the emitted loop under a real POSIX sh — the string is consumed
    // verbatim by both the systemd unit (bash) and the container onstart
    // script (#!/bin/sh), so running it is the only assertion that catches a
    // bashism or a broken loop. A `sleep` shell function records each
    // invocation instead of waiting, and the wrapped command exits the shell
    // with a sentinel code on its third iteration so the loop is bounded
    // whether or not it sleeps.
    function runLoop(innerCommand: 'true' | 'false', sleepSec?: number) {
      const cmd = `i=$((i+1)); if [ "$i" -ge 3 ]; then exit 3; fi; ${innerCommand}`;
      const loop =
        sleepSec === undefined
          ? rcloneContinuousLoop(cmd)
          : rcloneContinuousLoop(cmd, sleepSec);
      const result = spawnSync(
        'sh',
        ['-c', `sleep() { echo "SLEPT $1"; }; i=0; ${loop}`],
        { encoding: 'utf8' },
      );
      return {
        status: result.status,
        sleeps: result.stdout.split('\n').filter(Boolean),
      };
    }

    it('runs the command repeatedly and sleeps between attempts', () => {
      const { status, sleeps } = runLoop('true');
      expect(status).toBe(3); // reached the third iteration → it loops
      expect(sleeps).toEqual(['SLEPT 60', 'SLEPT 60']);
    });

    it('honors a custom sleep interval', () => {
      const { sleeps } = runLoop('true', 5);
      expect(sleeps).toEqual(['SLEPT 5', 'SLEPT 5']);
    });

    it('sleeps after a failed attempt instead of hot-looping', () => {
      // A persistently failing copy (expired token, revoked bucket access)
      // must wait out the interval between retries — not respin instantly,
      // hammering the storage API from the customer's VM until it recovers.
      const { status, sleeps } = runLoop('false');
      expect(status).toBe(3);
      expect(sleeps).toEqual(['SLEPT 60', 'SLEPT 60']);
    });
  });

  describe('rcloneInputSyncCommand', () => {
    it('downloads with retries (covers cred-propagation delays)', () => {
      const cmd = rcloneInputSyncCommand('s3:my-bucket', '/mnt/input');
      expect(cmd).toContain('rclone sync s3:my-bucket /mnt/input');
      expect(cmd).toContain('--retries 30');
      expect(cmd).toContain('--stats 1m --stats-one-line');
    });

    it('allows callers to override the rclone binary path', () => {
      const cmd = rcloneInputSyncCommand(
        's3:my-bucket',
        '/mnt/input',
        '/usr/local/bin/rclone',
      );
      expect(cmd).toContain(
        '/usr/local/bin/rclone sync s3:my-bucket /mnt/input',
      );
    });
  });

  describe('getRemotePath', () => {
    it('maps each cloud type to its rclone remote name', () => {
      expect(getRemotePath('b', CloudType.AWS)).toBe('s3:b');
      expect(getRemotePath('b', CloudType.GCP)).toBe('gcs:b');
      expect(getRemotePath('b', CloudType.Azure)).toBe('azureblob:b');
      expect(getRemotePath('b', CloudType.Cloudflare)).toBe('r2:b');
    });
    it('uses the shared smolvm filesystem namespace for Local', () => {
      expect(getRemotePath('b', CloudType.Local)).toBe(
        '/var/lib/anycloud/buckets/b',
      );
    });
  });
});
