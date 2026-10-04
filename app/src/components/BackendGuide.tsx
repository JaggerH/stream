import { useBackend } from '../lib/backend.tsx'

/**
 * Shown while the app isn't connected to a backend — guides the
 * user to start the backend and reflects the background re-probe,
 * with a manual reconnect. The connection auto-aligns once a backend appears
 * (BackendProvider re-probes), so this screen is replaced without a restart.
 */
export function BackendGuide() {
  const { status, reconnect } = useBackend()
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        padding: 24,
        textAlign: 'center',
      }}
    >
      <h1>未连接到 Stream 后端</h1>
      <p>请先启动后端（容器化部署）：</p>
      <pre>
        <code>docker compose up -d</code>
      </pre>
      <p data-testid="reprobe-status">
        {status === 'probing' ? '正在查找后端…' : '未找到后端，后台每隔几秒自动重试。'}
      </p>
      <button type="button" onClick={reconnect}>
        立即重连 (Reconnect)
      </button>
    </div>
  )
}
