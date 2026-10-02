import { RUNNER_BOUNDS } from '@parallax/contracts';
import { describe, expect, test } from 'vitest';
import { buildContainerConfig, buildHostConfig, type ResolvedImage } from './policy';

const image: ResolvedImage = {
  ref: 'parallax-runner-python:dev',
  id: `sha256:${'a'.repeat(64)}`,
  digest: null,
};
const limits = { wallSeconds: 10, memoryMiB: 512, outputBytes: 1048576 };
const job = { jobId: '6f1d2c3a-4b5e-4f60-9a71-82b3c4d5e6f7', limits };
const MiB = 1024 * 1024;

describe('container policy (design §7.3)', () => {
  test('every field of the create request', () => {
    expect(buildContainerConfig(job, image, 'runsc')).toEqual({
      Image: image.id,
      Hostname: 'sandbox',
      User: '10001:10001',
      WorkingDir: '/work',
      Cmd: ['python3', '/opt/parallax/harness/run.py'],
      Env: ['PARALLAX_JOB=1'],
      Labels: { 'parallax.runner': '1', 'parallax.job': job.jobId },
      AttachStdin: true,
      OpenStdin: true,
      StdinOnce: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      HostConfig: {
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        Tmpfs: {
          '/work': 'rw,noexec,nosuid,nodev,size=64m',
          '/tmp': 'rw,noexec,nosuid,nodev,size=64m',
        },
        Memory: 512 * MiB,
        MemorySwap: 512 * MiB,
        PidsLimit: 64,
        NanoCpus: 1e9,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Init: false,
        IpcMode: 'private',
        Ulimits: [
          { Name: 'core', Soft: 0, Hard: 0 },
          { Name: 'nofile', Soft: 256, Hard: 256 },
          { Name: 'fsize', Soft: 33554432, Hard: 33554432 },
        ],
        LogConfig: { Type: 'none', Config: {} },
        AutoRemove: false,
        Binds: undefined,
        Mounts: undefined,
        Runtime: 'runsc',
      },
    });
  });

  test('Init is false: the harness is pid 1', () => {
    const host = buildHostConfig(limits);
    expect(host.Init).toBe(false);
    expect(Object.hasOwn(host, 'Init')).toBe(true);
  });

  test('nothing is mounted, no network, no capabilities, read-only root', () => {
    const host = buildHostConfig(limits);
    expect(host.Binds).toBeUndefined();
    expect(host.Mounts).toBeUndefined();
    expect(host.NetworkMode).toBe('none');
    expect(host.CapDrop).toEqual(['ALL']);
    expect(host.ReadonlyRootfs).toBe(true);
    expect(host.Privileged).toBeUndefined();
  });

  test('Runtime is the passed parameter, absent when none is configured', () => {
    expect(buildHostConfig(limits, 'runsc').Runtime).toBe('runsc');
    expect(buildHostConfig(limits).Runtime).toBeUndefined();
  });

  test('memory at both bounds, 2048 MiB without int32 overflow', () => {
    const { min, max } = RUNNER_BOUNDS.memoryMiB;
    expect(buildHostConfig({ ...limits, memoryMiB: min }).Memory).toBe(64 * MiB);
    expect(buildHostConfig({ ...limits, memoryMiB: min }).MemorySwap).toBe(64 * MiB);
    expect(buildHostConfig({ ...limits, memoryMiB: max }).Memory).toBe(2147483648);
    expect(buildHostConfig({ ...limits, memoryMiB: max }).MemorySwap).toBe(2147483648);
  });

  test('limits outside the bounds are clamped', () => {
    expect(buildHostConfig({ ...limits, memoryMiB: 1_000_000 }).Memory).toBe(2048 * MiB);
    expect(buildHostConfig({ ...limits, memoryMiB: 1 }).Memory).toBe(64 * MiB);
  });

  test('fixed limits do not depend on the job', () => {
    for (const wallSeconds of [RUNNER_BOUNDS.wallSeconds.min, RUNNER_BOUNDS.wallSeconds.max]) {
      for (const outputBytes of [RUNNER_BOUNDS.outputBytes.min, RUNNER_BOUNDS.outputBytes.max]) {
        const host = buildHostConfig({ ...limits, wallSeconds, outputBytes });
        expect(host.PidsLimit).toBe(64);
        expect(host.NanoCpus).toBe(1e9);
        expect(host.Tmpfs).toEqual({
          '/work': 'rw,noexec,nosuid,nodev,size=64m',
          '/tmp': 'rw,noexec,nosuid,nodev,size=64m',
        });
      }
    }
  });
});
