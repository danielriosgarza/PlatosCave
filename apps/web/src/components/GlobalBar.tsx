import styles from './GlobalBar.module.css';

export function GlobalBar() {
  return (
    <header className={styles.top}>
      <div className={styles.left}>
        <a className={styles.brand} href="/">
          Parallax
        </a>
        <span aria-hidden="true" className={styles.divider} />
        <a href="/">Courses</a>
        <a href="/">Topics</a>
      </div>
      <nav className={styles.topicNav} aria-label="Neighbouring topics" />
    </header>
  );
}
