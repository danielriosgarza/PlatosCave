import type { OpenResource } from '@parallax/contracts';
import buttons from '../components/Buttons.module.css';
import styles from '../notebooks/Shiny.module.css';
import { ShinyEmbed } from '../notebooks/ShinyEmbed';

/**
 * A Shiny app at level 0 (Q19): framed by `ShinyEmbed` only when its origin is listed in
 * `origins.shiny` (`origin` is then set), and its external link in every case.
 */
export function OpenShiny({ title, url, origin }: Extract<OpenResource, { type: 'shiny' }>) {
  if (origin) return <ShinyEmbed title={title} url={url} origin={origin} />;
  return (
    <section className={styles.shiny} aria-label={title}>
      <header className={styles.head}>
        <h2>{title}</h2>
        <span className={styles.state}>Not embedded on this site</span>
        <a className={buttons.tool} href={url} target="_blank" rel="noopener noreferrer">
          Open externally
        </a>
      </header>
    </section>
  );
}
