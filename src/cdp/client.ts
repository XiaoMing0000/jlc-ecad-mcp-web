/**
 * Minimal Chrome DevTools Protocol client built on Node's native WebSocket.
 * No third-party dependencies.
 */

export interface CdpClientOptions {
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface CdpErrorPayload {
  code?: number;
  message?: string;
  data?: string;
}

interface CdpResponse {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: CdpErrorPayload;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export type CdpEventHandler<T = unknown> = (params: T) => void;

export class CdpClient {
  private readonly socket: WebSocket;
  private readonly requestTimeoutMs: number;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventHandlers = new Map<string, Set<CdpEventHandler>>();
  private closed = false;

  private constructor(socket: WebSocket, options: CdpClientOptions) {
    this.socket = socket;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;

    socket.addEventListener('message', (event) => this.handleMessage(event));
    socket.addEventListener('close', () => this.failAll(new Error('CDP connection closed.')));
    socket.addEventListener('error', () => this.failAll(new Error('CDP WebSocket error.')));
  }

  static async connect(wsUrl: string, options: CdpClientOptions = {}): Promise<CdpClient> {
    if (typeof WebSocket === 'undefined') {
      throw new Error('This Node.js runtime has no global WebSocket. Node.js 22+ is required.');
    }

    const socket = new WebSocket(wsUrl);
    const timeoutMs = options.connectTimeoutMs ?? 5_000;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        try {
          socket.close();
        } catch {
          // Ignore close errors on a socket that never opened.
        }
        reject(new Error(`Timed out connecting to Chrome DevTools at ${wsUrl}.`));
      }, timeoutMs);

      const cleanup = (): void => {
        clearTimeout(timer);
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
      };

      const onOpen = (): void => {
        cleanup();
        resolve();
      };

      const onError = (): void => {
        cleanup();
        try {
          socket.close();
        } catch {
          // Ignore close errors on a socket that never opened.
        }
        reject(new Error(`Could not connect to Chrome DevTools at ${wsUrl}.`));
      };

      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onError);
    });

    return new CdpClient(socket, options);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('CDP connection is closed.'));
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.failAll(new Error('CDP connection closed.'));
    try {
      this.socket.close();
    } catch {
      // Ignore close errors.
    }
  }

  /** Subscribe to a CDP event. Returns an unsubscribe function. */
  onEvent<T = unknown>(method: string, handler: CdpEventHandler<T>): () => void {
    let handlers = this.eventHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(method, handlers);
    }

    const entry = handler as CdpEventHandler;
    handlers.add(entry);
    return () => {
      handlers?.delete(entry);
    };
  }

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data !== 'string') {
      return;
    }

    let message: CdpResponse;
    try {
      message = JSON.parse(event.data) as CdpResponse;
    } catch {
      return;
    }

    if (typeof message.id !== 'number') {
      if (typeof message.method === 'string') {
        const handlers = this.eventHandlers.get(message.method);
        if (handlers) {
          for (const handler of handlers) {
            try {
              handler(message.params);
            } catch {
              // A failing event handler must not break the CDP connection.
            }
          }
        }
      }
      return; // Event notification, not a command response.
    }

    const request = this.pending.get(message.id);
    if (!request) {
      return;
    }
    this.pending.delete(message.id);

    if (message.error) {
      const code = message.error.code === undefined ? '' : ` ${message.error.code}`;
      request.reject(new Error(`CDP error${code}: ${message.error.message ?? 'unknown error'}`));
      return;
    }

    request.resolve(message.result);
  }

  private failAll(error: Error): void {
    this.closed = true;
    for (const request of this.pending.values()) {
      request.reject(error);
    }
    this.pending.clear();
  }
}
