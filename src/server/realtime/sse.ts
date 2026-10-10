/**
 * SSE(Server-Sent Events)基础工具。
 * Phase 2 起用于 Agent 进度、日志、终端输出的单向实时推送;
 * 需要双向交互的终端(Phase 6)再评估升级为 WebSocket。
 */

const encoder = new TextEncoder();

export function encodeSSEEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export interface SSEWriter {
  stream: ReadableStream<Uint8Array>;
  send: (event: string, data: unknown) => void;
  close: () => void;
}

export interface CreateSSEWriterOptions {
  /** 心跳注释帧间隔(毫秒),防止代理断开长连接;传 0 关闭。 */
  heartbeatMs?: number;
}

export function createSSEWriter(options: CreateSSEWriterOptions = {}): SSEWriter {
  const heartbeatMs = options.heartbeatMs ?? 15_000;

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      stopHeartbeat();
      closed = true;
    },
  });

  function stopHeartbeat() {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  let heartbeat: ReturnType<typeof setInterval> | null =
    heartbeatMs > 0
      ? setInterval(() => {
          if (!controller || closed) return;
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            stopHeartbeat();
            closed = true;
          }
        }, heartbeatMs)
      : null;

  return {
    stream,
    send(event, data) {
      if (closed || !controller) return;
      try {
        controller.enqueue(encoder.encode(encodeSSEEvent(event, data)));
      } catch {
        stopHeartbeat();
        closed = true;
      }
    },
    close() {
      if (closed || !controller) return;
      stopHeartbeat();
      closed = true;
      try {
        controller.close();
      } catch {
        // stream 已被下游关闭,忽略
      }
    },
  };
}

export function sseResponse(stream: ReadableStream<Uint8Array>, init?: ResponseInit): Response {
  return new Response(stream, {
    ...init,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...init?.headers,
    },
  });
}
