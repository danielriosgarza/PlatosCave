import styles from './Page.module.css';

/** The one loading indicator: a visible label in a status region, so it is announced (§14). */
export function Loading({ label, className }: { label: string; className?: string }) {
  return (
    <p className={className ?? styles.loading} role="status">
      {label}
    </p>
  );
}
