import { defineConfig } from 'parallax-site';

export default defineConfig({
  mode: 'instructor',
  name: 'Reef ecology',
  level: 1,
  origins: {
    app: 'https://reef.example.org',
    content: 'https://content.reef.example.org',
    shiny: ['https://shiny.example.org'],
  },
  signIn: { email: { from: 'Reef ecology <login@example.org>' } },
});
