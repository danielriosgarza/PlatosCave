import { health } from '@parallax/contracts/routes/health';
import { createFileRoute } from '@tanstack/react-router';
import { useApi } from '../api/client';

export const Route = createFileRoute('/')({ component: Home });

function Home() {
  const { data, isError } = useApi(health, {});
  const line = data
    ? `API ${data.status} · database ${data.db}`
    : isError
      ? 'API unavailable'
      : 'Checking API…';
  return (
    <main id="main" style={{ padding: 'var(--pc-space-32) var(--pc-space-28)' }}>
      <h1>Parallax</h1>
      <p role="status">{line}</p>
    </main>
  );
}
