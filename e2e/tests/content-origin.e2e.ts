import { expect, test } from '@playwright/test';

const app = 'http://127.0.0.1:3100';
const content = 'http://localhost:3100';

test('P1-06 the content origin serves only token URLs; the app origin serves no content URLs', async ({
  request,
}) => {
  expect((await request.get(`${app}/api/health`)).status()).toBe(200);
  for (const path of ['/api/health', '/', '/content/not-a-token']) {
    const res = await request.get(`${content}${path}`);
    expect(res.status(), path).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  }
  expect((await request.get(`${app}/content/not-a-token`)).status()).toBe(404);
});
