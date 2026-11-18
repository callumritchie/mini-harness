import type { ClientRequest, ServerEvent } from "./protocol";

export interface Socket {
  send(request: ClientRequest): boolean;
  close(): void;
}

/** A WebSocket to the server that reconnects by itself. `onEvent` gets every server event; `onState` tells whether we are connected. */
export function connect(token: string, onEvent: (e: ServerEvent) => void, onState: (connected: boolean) => void): Socket {
  let ws: WebSocket | null = null;
  let closed = false;
  let delay = 300;

  const open = () => {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${scheme}://${window.location.host}/ws?token=${encodeURIComponent(token)}`);
    ws.onopen = () => {
      delay = 300;
      onState(true);
    };
    ws.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data) as ServerEvent);
      } catch {
        /* ignore a malformed message */
      }
    };
    ws.onclose = () => {
      onState(false);
      if (!closed) {
        setTimeout(open, delay);
        delay = Math.min(delay * 2, 5000);
      }
    };
  };
  open();

  return {
    send(request) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(request));
        return true;
      }
      return false;
    },
    close() {
      closed = true;
      ws?.close();
    },
  };
}
