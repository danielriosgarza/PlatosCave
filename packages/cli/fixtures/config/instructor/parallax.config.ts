import { defineConfig } from 'parallax-site';

export default defineConfig({
  mode: 'instructor',
  name: 'Statistics for Biologists',
  logo: { file: 'src/logo.png', alt: 'Statistics for Biologists' },
  level: 1,
  origins: { app: 'https://stats.example.org', content: 'https://content.stats.example.org' },
  signIn: { email: { from: 'Statistics <login@example.org>' } },
  classes: [
    { course: 'statistics', name: 'Spring 2027' },
    { course: 'statistics', name: 'Open course', open: true },
  ],
});
