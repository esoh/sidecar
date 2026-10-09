// WebSockets avoid the browser's six-per-origin HTTP connection pool used by EventSource.
export class ViewerEvents {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private delay = 250;
  private stopped = false;
  private events = new EventTarget();
  private bootstrap?: AbortController;

  constructor(path: string) {
    const url = new URL(path, location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const connect = async (reconnecting = false) => {
      if (this.stopped) return;
      if (reconnecting) {
        // Local viewer cookies change on app/gateway restart; renew without reloading the draft.
        const bootstrap = this.bootstrap = new AbortController();
        const timeout = setTimeout(() => bootstrap.abort(), 5000);
        try { const response = await fetch(location.href, { signal: bootstrap.signal, cache: 'no-store' }); await response.body?.cancel(); }
        catch { /* The next connection attempt uses the normal retry backoff. */ }
        finally { clearTimeout(timeout); }
      }
      if (this.stopped) return;
      const socket = this.socket = new WebSocket(url);
      let buffer = '';
      socket.onopen = () => { if (!this.stopped) { this.delay = 250; this.onopen?.(); } };
      socket.onmessage = ({ data }) => {
        buffer += data;
        let boundary: number;
        // The internal event stream may split an event across several WebSocket messages.
        while (!this.stopped && (boundary = buffer.indexOf('\n\n')) >= 0) {
          const lines = buffer.slice(0, boundary).split('\n'); buffer = buffer.slice(boundary + 2);
          const type = lines.find(line => line.startsWith('event: '))?.slice(7);
          if (type) this.events.dispatchEvent(new MessageEvent(type, { data: lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n') }));
        }
      };
      socket.onclose = () => {
        if (this.stopped) return;
        this.onerror?.();
        this.retry = setTimeout(() => { void connect(true); }, this.delay);
        this.delay = Math.min(this.delay * 2, 5000);
      };
    };
    void connect();
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.events.addEventListener(type, event => { if (event instanceof MessageEvent) listener(event); });
  }

  close() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.bootstrap?.abort();
    this.socket?.close();
  }
}
