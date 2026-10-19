import styles from './page.module.css';

export const title = 'About';

export default function About() {
  return (
    <main id="main" className={styles.page}>
      <h1>About the school</h1>
      <p>A fictional school whose courses are published as an open site.</p>
    </main>
  );
}
