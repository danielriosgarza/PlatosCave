import { defineConfig } from 'parallax-site';

export default defineConfig({
  mode: 'school',
  name: 'Example School of Biology',
  // logo: { file: 'src/logo.png', alt: 'Example School of Biology' },
  level: 1,
  origins: { app: 'https://school.example.org', content: 'https://content.school.example.org' },
  signIn: { email: { from: 'Example School of Biology <login@example.org>' } },
  instructors: ['ana', 'ben'],
  classes: [
    { course: 'ana/reef-ecology', name: 'Spring 2027' },
    { course: 'ben/field-statistics', name: 'Spring 2027' },
  ],
});
