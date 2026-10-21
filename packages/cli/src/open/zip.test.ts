import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { unzip } from './testing';
import { zip } from './zip';

const utf8 = (text: string) => new TextEncoder().encode(text);
const entries = [
  { path: 'counts/counts.ipynb', bytes: utf8('{"cells": []}') },
  { path: 'counts/data/quadrats.csv', bytes: utf8('quadrat,count\n1,12\n'.repeat(50)) },
  { path: 'counts/data/größe.txt', bytes: new Uint8Array() },
];

test('A44 a zip holds each file at its path with its bytes, and the same files give the same bytes', () => {
  const archive = zip(entries);
  const read = unzip(archive);
  expect([...read.keys()]).toEqual(entries.map(({ path }) => path));
  for (const { path, bytes } of entries) expect(read.get(path)).toEqual(bytes);
  expect(zip(entries)).toEqual(archive);
});

// Read by a program of its own as well, so the format is not judged only by `unzip` above.
test('A44 the unzip program reads the zip and finds no error', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'parallax-zip-'));
  try {
    const file = join(dir, 'counts.zip');
    fs.writeFileSync(file, zip(entries));
    const checked = spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
    expect([checked.status, checked.stdout]).toEqual([0, expect.stringContaining('No errors')]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
