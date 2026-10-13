import { defineConfig } from 'parallax-site';

export default defineConfig({
  mode: 'school',
  name: 'Example School of Biology',
  level: 2,
  origins: {
    app: 'https://school.example.org',
    content: 'https://content.school.example.org',
    shiny: ['https://shiny.example.org'],
  },
  signIn: { email: { from: 'Example School <login@example.org>' } },
  instructors: ['ana', 'ben'],
  classes: [
    { course: 'ana/reef-ecology', name: 'Spring 2027', instructors: ['ana', 'ben'] },
    { course: 'ben/statistics', name: 'Open course', open: true },
  ],
  runner: {
    host: '10.0.0.7',
    databaseHost: '10.0.0.2',
    runtimes: [
      {
        id: 'python-3.12',
        language: 'python',
        image: 'registry.example.org/parallax-runner-python',
        digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
        harnessVersion: '4',
        packages: ['numpy', 'pandas'],
      },
    ],
  },
});
