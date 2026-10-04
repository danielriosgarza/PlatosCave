import { health } from '@parallax/contracts/routes/health';
import { createFileRoute } from '@tanstack/react-router';
import { useApi } from '../api/client';
import page from '../components/Page.module.css';

export const Route = createFileRoute('/')({ component: Home });

function Home() {
  const { data, isError } = useApi(health, {});
  const line = data
    ? `API ${data.status} · database ${data.db}`
    : isError
      ? 'API unavailable'
      : 'Checking API…';
  return (
    <main id="main" className={page.homeMain}>
      <h1>Parallax</h1>
      <p role="status">{line}</p>
    </main>
  );
}
