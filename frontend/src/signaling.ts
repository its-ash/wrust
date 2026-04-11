import type { PresenceSession, SignalMessage } from "./types";

type CreateSessionResult = {
  session_id: string;
  expires_in: number;
  ws_url: string;
};

type JoinSessionResult = {
  ok: boolean;
  ws_url: string;
  requires_sender_approval: boolean;
  message?: string;
};

export class SignalingClient {
  private ws: WebSocket | null = null;
  private readonly baseUrl: string;
  private onMessageHandlers = new Set<(msg: SignalMessage) => void>();
  private onCloseHandlers = new Set<() => void>();

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async createSession(payload: {
    name: string;
    file_count: number;
    total_size: number;
    network_hint?: string;
  }): Promise<CreateSessionResult> {
    const response = await fetch(`${this.baseUrl}/api/session`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        type: "create_session",
        name: payload.name,
        file_count: payload.file_count,
        total_size: payload.total_size,
        has_pin: false,
        public_presence: false,
        network_hint: payload.network_hint
      })
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `create_session failed (${response.status})`);
    }

    return (await response.json()) as CreateSessionResult;
  }

  async joinSession(payload: {
    session_id: string;
    network_hint?: string;
  }): Promise<JoinSessionResult> {
    const response = await fetch(`${this.baseUrl}/api/session/join`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        type: "join_session",
        session_id: payload.session_id,
        network_hint: payload.network_hint
      })
    });

    const body = (await response.json()) as JoinSessionResult;
    if (!response.ok || !body.ok) {
      throw new Error(body.message ?? `join_session failed (${response.status})`);
    }

    return body;
  }

  async listPresence(networkHint?: string): Promise<PresenceSession[]> {
    const query = networkHint ? `?network_hint=${encodeURIComponent(networkHint)}` : "";
    const response = await fetch(`${this.baseUrl}/api/presence${query}`);
    if (!response.ok) {
      return [];
    }
    return (await response.json()) as PresenceSession[];
  }

  connect(wsUrl: string): void {
    this.disconnect();
    this.ws = new WebSocket(wsUrl);

    this.ws.onmessage = (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      try {
        const parsed = JSON.parse(event.data) as SignalMessage;
        for (const handler of this.onMessageHandlers) {
          handler(parsed);
        }
      } catch {
        // Ignore malformed signaling payloads.
      }
    };

    this.ws.onclose = () => {
      for (const handler of this.onCloseHandlers) {
        handler();
      }
    };
  }

  send(msg: SignalMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  onMessage(handler: (msg: SignalMessage) => void): () => void {
    this.onMessageHandlers.add(handler);
    return () => this.onMessageHandlers.delete(handler);
  }

  onClose(handler: () => void): () => void {
    this.onCloseHandlers.add(handler);
    return () => this.onCloseHandlers.delete(handler);
  }

  disconnect(): void {
    if (!this.ws) {
      return;
    }
    this.ws.close();
    this.ws = null;
  }
}
