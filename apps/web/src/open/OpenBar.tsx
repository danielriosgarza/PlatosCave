import { Link } from '@tanstack/react-router';
import type { MouseEvent } from 'react';
import styles from '../components/GlobalBar.module.css';
import { useFocusActive } from '../workspace/focus';

/** Moves focus to the page's main region, as the global bar's skip link does. */
function skipToContent(event: MouseEvent<HTMLAnchorElement>) {
  const main = document.querySelector('main');
  if (!main) return;
  event.preventDefault();
  main.setAttribute('tabindex', '-1');
  main.focus();
  main.scrollIntoView?.();
}

/** The bar of the open site (§6): no sign-in, account or class. It hides in Focus. */
export function OpenBar() {
  if (useFocusActive()) return null;
  return (
    <header className={styles.top}>
      {/* biome-ignore lint/a11y/useValidAnchor: a skip link is a same-page anchor; the handler only adds focus */}
      <a className={styles.skip} href="#main" onClick={skipToContent}>
        Skip to content
      </a>
      <div className={styles.left}>
        <Link className={styles.brand} to="/">
          Parallax
        </Link>
        <span aria-hidden="true" className={styles.divider} />
        <nav className={styles.primaryNav} aria-label="Primary">
          <Link to="/courses">Courses</Link>
        </nav>
      </div>
    </header>
  );
}
