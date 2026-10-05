import { describe, expect, it } from 'vitest';
import type { Strokes } from './anchors';
import { strokesToSvg } from './sketch';

const pen = (points: [number, number][], color = '#202124', width = 3): Strokes[number] => ({
  tool: 'pen',
  color,
  width,
  points,
});

describe('strokesToSvg', () => {
  it('A07 exports a drawing as SVG with its description as accessible text', () => {
    const svg = strokesToSvg(
      [
        pen([
          [0, 0],
          [0.5, 0.5],
          [1, 1],
        ]),
      ],
      { aspect: 0.5, title: 'Sketch · Figure 1', description: 'Two curves <meet> at "10".' },
    );
    expect(svg).toContain('viewBox="0 0 900 450"');
    expect(svg).toContain('points="0,0 450,225 900,450"');
    expect(svg).toContain('<title>Sketch · Figure 1</title>');
    // Markup in the description is escaped, never inserted.
    expect(svg).toContain('<desc>Two curves &#60;meet&#62; at &#34;10&#34;.</desc>');
    expect(svg).not.toContain('<meet>');
  });

  it('A07 an eraser removes only what was drawn before it', () => {
    const svg = strokesToSvg(
      [
        pen([
          [0, 0.5],
          [1, 0.5],
        ]),
        {
          tool: 'eraser',
          color: '#ffffff',
          width: 20,
          points: [
            [0.5, 0],
            [0.5, 1],
          ],
        },
        pen([
          [0, 0.2],
          [1, 0.2],
        ]),
      ],
      { aspect: 1 },
    );
    const masked = svg.indexOf('<g mask="url(#erase-1)">');
    expect(masked).toBeGreaterThan(-1);
    // The first line is inside the mask group, the later one outside it.
    expect(svg.indexOf('0,450 900,450')).toBeGreaterThan(masked);
    expect(svg.indexOf('0,180 900,180')).toBeGreaterThan(svg.indexOf('</g>'));
  });

  it('A07 a single touch is a dot', () => {
    expect(strokesToSvg([pen([[0.5, 0.5]], '#315747', 6)], { aspect: 1 })).toContain(
      '<circle cx="450" cy="450" r="3" fill="#315747"/>',
    );
  });
});
