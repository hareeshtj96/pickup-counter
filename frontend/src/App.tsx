import { useEffect, useState } from 'react';
import { ApiError, apiGet } from './api/client';

type HealthResponse = {
  status: 'ok' | 'error';
  database: 'up' | 'down';
  timestamp: string;
};

type HealthState =
  | { kind: 'loading' }
  | { kind: 'ok'; data: HealthResponse }
  | { kind: 'error'; message: string };

export function App() {
  const [health, setHealth] = useState<HealthState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    apiGet<HealthResponse>('/health', { signal: controller.signal })
      .then((data) => setHealth({ kind: 'ok', data }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setHealth({
          kind: 'error',
          message: err instanceof ApiError ? err.message : 'Unexpected error.',
        });
      });
    return () => controller.abort();
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: 640 }}>
      <h1>Pickup Counter</h1>
      <p>The frontend is running.</p>

      <h2>Backend status</h2>
      {health.kind === 'loading' && <p>Checking API…</p>}
      {health.kind === 'ok' && (
        <p data-testid="api-status">
          API: <strong>{health.data.status}</strong> · Database:{' '}
          <strong>{health.data.database}</strong>
        </p>
      )}
      {health.kind === 'error' && (
        <p data-testid="api-status" role="alert">
          API unreachable: {health.message}
        </p>
      )}
    </main>
  );
}
