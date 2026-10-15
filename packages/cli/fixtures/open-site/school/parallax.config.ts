import { defineConfig } from 'parallax-site';

// The open site (level 0) of a school: Ana Lima's "Reef ecology", declared public with its overlay
// under private/, and Bao Tran's "Tide pools", declared private.
export default defineConfig({
  mode: 'school',
  name: 'Example School of Marine Biology',
  level: 0,
  origins: {
    app: 'https://school.example.org',
    content: 'https://content.school.example.org',
    shiny: ['https://shiny.example.org'],
  },
  instructors: ['ana', 'bao'],
});
