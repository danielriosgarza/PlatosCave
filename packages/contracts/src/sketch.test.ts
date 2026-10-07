// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Strokes } from "./anchors";
import { strokesToSvg } from "./sketch";

const pen = (
  points: [number, number][],
  color = "#202124",
  width = 3,
): Strokes[number] => ({
  tool: "pen",
  color,
  width,
  points,
});

describe("strokesToSvg", () => {
  it("A07 exports a drawing as SVG with its description as accessible text", () => {
    const svg = strokesToSvg(
      [
        pen([
          [0, 0],
          [0.5, 0.5],
          [1, 1],
        ]),
      ],
      {
        aspect: 0.5,
        title: "Sketch · Figure 1",
        description: 'Two curves <meet> at "10".',
      },
    );
    expect(svg).toContain('viewBox="0 0 900 450"');
    expect(svg).toContain('points="0,0 450,225 900,450"');
    expect(svg).toContain("<title>Sketch · Figure 1</title>");
    // Markup in the description is escaped, never inserted.
    expect(svg).toContain(
      "<desc>Two curves &#60;meet&#62; at &#34;10&#34;.</desc>",
    );
    expect(svg).not.toContain("<meet>");
  });

  it("A07 an eraser removes only what was drawn before it", () => {
    const svg = strokesToSvg(
      [
        pen([
          [0, 0.5],
          [1, 0.5],
        ]),
        {
          tool: "eraser",
          color: "#ffffff",
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
    expect(svg.indexOf("0,450 900,450")).toBeGreaterThan(masked);
    expect(svg.indexOf("0,180 900,180")).toBeGreaterThan(svg.indexOf("</g>"));
  });

  it("A07 a single touch is a dot", () => {
    expect(
      strokesToSvg([pen([[0.5, 0.5]], "#315747", 6)], { aspect: 1 }),
    ).toContain('<circle cx="450" cy="450" r="3" fill="#315747"/>');
  });
});

describe("strokesToSvg well-formedness", () => {
  it("A07 a description or title with control characters still exports well-formed XML", () => {
    const controls = "\u0000\u0001\u0008\u000B\u000C\u000E\u001F\uFFFE\uFFFF";
    const svg = strokesToSvg(
      [
        pen([
          [0, 0],
          [1, 1],
        ]),
      ],
      {
        aspect: 0.5,
        title: `Sketch${controls}`,
        description: `Line\ttab\nnewline\rreturn ${controls} <end> & "q"`,
      },
    );
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(doc.documentElement.localName).toBe("svg");
    // Tab, line feed and carriage return are legal XML and are kept (a raw CR parses as LF).
    expect(doc.querySelector("desc")?.textContent).toBe(
      'Line\ttab\nnewline\nreturn  <end> & "q"',
    );
    expect(doc.querySelector("title")?.textContent).toBe("Sketch");
  });
});
