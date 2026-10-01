/* Subject marks ported from the wireframe's courseMark(); one small mark per card (§4). */
const marks = [
  <path key="distribution" d="M3 45H73M5 44C24 44 26 7 38 7S52 44 71 44" />,
  <g key="growth">
    <path d="M5 48V6M5 48H74M8 45C26 45 23 40 33 27S41 10 70 10" />
    <path d="M8 41C25 38 39 33 52 20S66 11 70 10" strokeDasharray="2 4" />
  </g>,
  <path
    key="sequence"
    d="M6 43H72M10 43V30M18 43V17M26 43V25M34 43V8M42 43V15M50 43V34M58 43V24M66 43V11"
  />,
  <g key="network">
    <path d="M13 27L35 9 64 23 47 46 13 27 64 23M35 9L47 46" />
    <circle cx="13" cy="27" r="4" />
    <circle cx="35" cy="9" r="4" />
    <circle cx="64" cy="23" r="4" />
    <circle cx="47" cy="46" r="4" />
  </g>,
  <g key="phase">
    <ellipse cx="39" cy="28" rx="31" ry="18" />
    <ellipse cx="39" cy="28" rx="22" ry="12" />
    <ellipse cx="39" cy="28" rx="10" ry="6" />
    <path d="M3 51H75M5 51V4" />
  </g>,
  <path
    key="measure"
    d="M8 45H72M8 45V5M16 37L27 29 39 26 51 16 64 9M16 32V42M27 24V34M39 21V31M51 11V21M64 5V14"
  />,
];

/** The same course always gets the same mark. */
function pick(seed: string): number {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % marks.length;
}

export function CourseMark({ seed, className }: { seed: string; className?: string }) {
  return (
    <span className={className}>
      <svg
        viewBox="0 0 78 56"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {marks[pick(seed)]}
      </svg>
    </span>
  );
}
