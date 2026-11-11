import { WebSocket } from 'ws';

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

/**
 * Wakes the hand-off worker when a turn completes anywhere. The socket only makes hand-offs sooner:
 * the worker's catch-up over HTTP is what makes them happen, so a dropped socket loses nothing.
 * It authenticates with the service token, which may subscribe to `org:events` and see every chat.
 */
export function watchEngine({ baseUrl, token, onTurnCompleted, log = line => console.warn(line) }: {
  baseUrl: string; token: string; onTurnCompleted: (channelId: string) => void; log?: (line: string) => void;
}): { close(): void } {
  const target = new URL('/ws', baseUrl);
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = FIRST_RETRY_MS;
  let closed = false;
  let reported: string | null = null;
  const report = (problem: string | null) => {
    if (problem === reported) return;
    reported = problem;
    if (problem) log(`[flows] engine watch disconnected: ${problem}`);
  };

  function retry() {
    if (closed || timer) return;
    timer = setTimeout(() => { timer = null; connect(); }, delay);
    timer.unref?.();
    delay = Math.min(delay * 2, MAX_RETRY_MS);
  }

  function connect() {
    if (closed) return;
    const ws = new WebSocket(target, { headers: { 'x-orgops-runner-token': token }, handshakeTimeout: 10_000, maxPayload: 1024 * 1024 });
    socket = ws;
    ws.on('open', () => {
      delay = FIRST_RETRY_MS;
      report(null);
      (ws as unknown as { _socket?: { unref?: () => void } })._socket?.unref?.();
      ws.send(JSON.stringify({ type: 'subscribe', topic: 'org:events' }));
    });
    ws.on('message', raw => {
      let message: { type?: unknown; data?: { type?: unknown; channelId?: unknown } } | null;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      const data = message?.type === 'event' ? message.data : undefined;
      if (data?.type === 'agent.turn.completed' && typeof data.channelId === 'string') {
        try { onTurnCompleted(data.channelId); } catch (error) { log(`[flows] wake-up failed: ${error instanceof Error ? error.name : 'Error'}`); }
      }
    });
    // Only an error's name: the handshake error can carry the request, never logged.
    ws.on('error', error => report(error instanceof Error ? error.name : 'Error'));
    ws.on('close', () => {
      if (socket === ws) socket = null;
      retry();
    });
  }

  connect();
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      socket?.terminate();
      socket = null;
    },
  };
}
