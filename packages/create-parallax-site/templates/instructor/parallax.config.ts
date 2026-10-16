import { defineConfig } from 'parallax-site';

export default defineConfig({
  mode: 'instructor',
  name: 'Introduction to Statistics',
  // logo: { file: 'src/logo.png', alt: 'Introduction to Statistics' },
  level: 1,
  origins: { app: 'https://stats.example.org', content: 'https://content.stats.example.org' },
  signIn: { email: { from: 'Introduction to Statistics <login@example.org>' } },
  classes: [{ course: 'statistics', name: 'Spring 2027' }],
});
