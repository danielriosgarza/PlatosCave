import { defineConfig } from 'parallax-site';

export default defineConfig({
  mode: 'school',
  name: 'Example School of Biology',
  level: 1,
  origins: { app: 'https://school.example.org', content: 'https://content.school.example.org' },
  signIn: { email: { from: 'Example School <login@example.org>' } },
  instructors: ['ana', 'ben'],
});
