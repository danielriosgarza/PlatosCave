import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(cleanup);

const css = readFileSync(join(__dirname, 'Buttons.module.css'), 'utf8');
const BUTTON_CLASS = /^\.(primary|outline|textButton|button|tool)\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

describe('shared buttons', () => {
  it('shows a disabled outline button visibly distinct from an enabled one', () => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    render(
      <>
        <button type="button" className="outline">
          Enabled
        </button>
        <button type="button" className="outline" disabled>
          Disabled
        </button>
      </>,
    );
    const enabled = getComputedStyle(screen.getByRole('button', { name: 'Enabled' }));
    const disabled = getComputedStyle(screen.getByRole('button', { name: 'Disabled' }));
    expect(enabled.opacity).not.toBe('0.55');
    expect(disabled.opacity).toBe('0.55');
    expect(disabled.cursor).toBe('default');
    style.remove();
  });

  it('defines focus-visible and disabled states for every button class', () => {
    for (const name of ['primary', 'outline', 'textButton', 'tool']) {
      expect(css).toContain(`.${name}:disabled`);
      expect(css).toContain(`.${name}:focus-visible`);
    }
  });

  it('keeps one stylesheet that defines button classes and no literal font size in style props', () => {
    const root = join(__dirname, '..');
    const files = sourceFiles(root);
    const definers = files
      .filter((f) => f.endsWith('.module.css'))
      .filter((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .some((l) => BUTTON_CLASS.test(l)),
      );
    expect(definers.map((f) => f.slice(root.length + 1))).toEqual([
      'components/Buttons.module.css',
    ]);
    const offenders = files
      .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))
      .filter((f) => /style=\{\{[^}]*fontSize/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
