import { defineConfig } from 'parallax-site';

// The open site (level 0) of one instructor, Ana Lima: a course declared public, whose exercises
// and tests lie in the overlay private/, and a course declared private, which keeps them in its tree.
export default defineConfig({
  mode: 'instructor',
  name: 'Reef ecology',
  level: 0,
  origins: {
    app: 'https://reef.example.org',
    content: 'https://content.reef.example.org',
    shiny: ['https://shiny.example.org'],
  },
});
