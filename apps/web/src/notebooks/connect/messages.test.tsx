import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CATALOGUE_CAUSE_COPY,
  CAUSE_COPY,
  CAUSE_RECOVERIES,
  CODE_COPY,
  CODE_RECOVERIES,
  CODE_STAGE,
  RECOVERY_COPY,
  STAGE_LABEL,
} from './messages';

interface Catalogue {
  causes: Record<string, string>;
  recoveries: Record<string, string> | string[];
  codes: Record<string, { cause: string; recoveries: string[]; stage: string | null }>;
  loss: Record<string, { recoveries: string[] }>;
}

const catalogue = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../../connector/protocol/v1/errors.json'), 'utf8'),
) as Catalogue;

describe('connect messages', () => {
  it('every catalogue code has copy and the catalogue’s recoveries', () => {
    for (const [code, entry] of Object.entries(catalogue.codes)) {
      expect(CODE_COPY[code], `copy for ${code}`).toBeTruthy();
      expect(CODE_RECOVERIES[code], `recoveries for ${code}`).toEqual(entry.recoveries);
    }
    expect(Object.keys(CODE_COPY).sort()).toEqual(Object.keys(catalogue.codes).sort());
  });

  it('every catalogue code that names a stage maps to it, with a label', () => {
    for (const [code, entry] of Object.entries(catalogue.codes)) {
      expect(CODE_STAGE[code] ?? null, `stage of ${code}`).toBe(entry.stage);
      if (entry.stage) expect(STAGE_LABEL[entry.stage], `label of ${entry.stage}`).toBeTruthy();
    }
  });

  it('every loss cause has copy and the catalogue’s recoveries', () => {
    for (const [cause, entry] of Object.entries(catalogue.loss)) {
      expect(CAUSE_COPY[cause], `copy for ${cause}`).toBeTruthy();
      expect(CAUSE_RECOVERIES[cause], `recoveries for ${cause}`).toEqual(entry.recoveries);
    }
    expect(Object.keys(CAUSE_COPY).sort()).toEqual(Object.keys(catalogue.loss).sort());
  });

  it('every recovery, cause of spec §14 and stage has a name', () => {
    for (const r of Array.isArray(catalogue.recoveries)
      ? catalogue.recoveries
      : Object.keys(catalogue.recoveries))
      expect(RECOVERY_COPY, r).toHaveProperty(r);
    for (const c of Object.keys(catalogue.causes))
      expect(CATALOGUE_CAUSE_COPY, c).toHaveProperty(c);
    for (const entry of Object.values(catalogue.codes)) {
      if (entry.stage) expect(STAGE_LABEL, entry.stage).toHaveProperty(entry.stage);
    }
  });

  it('no copy shows raw tool output or a secret', () => {
    for (const text of [...Object.values(CODE_COPY), ...Object.values(CAUSE_COPY)]) {
      expect(text).not.toMatch(/password:|passphrase:|token=|BEGIN [A-Z ]*PRIVATE KEY/i);
    }
  });
});
