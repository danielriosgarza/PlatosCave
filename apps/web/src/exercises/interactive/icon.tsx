import { useEffect, useState } from 'react';
import styles from './Interactive.module.css';

/**
 * The icons of interactive exercises (`packages/contracts/src/icons.ts`), drawn from Parallax's
 * own copy of their path data. The data is large and most exercises draw no icon, so it is
 * fetched once, by the first exercise that does.
 */

type Paths = Readonly<Record<string, string>>;

let loaded: Paths | null = null;
let loading: Promise<Paths> | null = null;

function load(): Promise<Paths> {
  loading ??= import('./iconPaths.gen').then(
    (m) => {
      loaded = m.ICON_PATHS;
      return loaded;
    },
    (error: unknown) => {
      // A failed fetch is tried again by the next exercise that draws an icon.
      loading = null;
      throw error;
    },
  );
  return loading;
}

/** The icons' path data once fetched, or null; nothing is fetched while `wanted` is false. */
export function useIconPaths(wanted: boolean): Paths | null {
  const [paths, setPaths] = useState(loaded);
  useEffect(() => {
    if (!wanted || paths) return;
    let live = true;
    load().then(
      (p) => {
        if (live) setPaths(p);
      },
      // Without the data icons are not drawn; every piece still shows or says its label.
      () => {},
    );
    return () => {
      live = false;
    };
  }, [wanted, paths]);
  return paths;
}

/**
 * An icon's elements on its 24-unit square, in the stroke and fill of the element around them;
 * its dots are filled in the stroke colour.
 */
export function IconPaths({ data }: { data: string }) {
  return (
    <>
      {data.split('|').map((d, i) =>
        d.startsWith('*') ? (
          // An icon's elements are positional, and never reordered.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <path key={i} d={d.slice(1)} fill="currentColor" />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <path key={i} d={d} />
        ),
      )}
    </>
  );
}

/** An icon in a line of text or on a button, in the text's colour; it says nothing itself. */
export function Glyph({ name, size = 24 }: { name: string; size?: number }) {
  const paths = useIconPaths(true);
  const data = paths?.[name];
  return (
    <svg
      className={styles.glyph}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      {data ? <IconPaths data={data} /> : null}
    </svg>
  );
}
