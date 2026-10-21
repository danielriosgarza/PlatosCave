import { defineConfig } from 'parallax-site';

// The site's configuration. The values are samples on example.org: replace the name, the two host
// names and the sign-in sender before the first start. The course Welcome to Parallax explains
// each field (courses/welcome/start-here/reading/guide.md).
export default defineConfig({
  mode: 'instructor',
  name: 'My Parallax site',
  // logo: { file: 'src/logo.png', alt: 'My Parallax site' },
  level: 1,
  origins: { app: 'https://site.example.org', content: 'https://content.site.example.org' },
  signIn: { email: { from: 'My Parallax site <login@example.org>' } },
  classes: [{ course: 'welcome', name: 'Spring 2027' }],
});
