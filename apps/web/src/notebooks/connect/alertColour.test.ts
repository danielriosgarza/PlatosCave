import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = join(__dirname, '..', '..');

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return path.endsWith('.css') ? [path] : [];
  });
}

describe('connect alerts use a neutral ground', () => {
  const css = readFileSync(join(__dirname, 'Connect.module.css'), 'utf8');
  const alert = /\.alert\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';

  it('A29 failing-stage alert is neutral with an ink border, not passage yellow', () => {
    expect(alert).toContain('background: var(--pc-secondary)');
    expect(alert).toContain('border-left: 3px solid var(--pc-ink)');
    expect(alert).not.toContain('--pc-highlight');
  });

  it('A30 host-key change alert is not coloured by the highlight token anywhere in notebooks or assessments', () => {
    for (const dir of ['notebooks', 'assessments']) {
      for (const file of cssFiles(join(src, dir))) {
        expect(readFileSync(file, 'utf8'), file).not.toContain('--pc-highlight');
      }
    }
  });

  it('A36 loss and reconnect alerts share the neutral .alert class', () => {
    for (const file of ['LossNotice.tsx', 'StageList.tsx', 'DeviceList.tsx']) {
      expect(readFileSync(join(__dirname, file), 'utf8'), file).toContain('styles.alert');
    }
  });
});
