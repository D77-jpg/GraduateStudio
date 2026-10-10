import { describe, expect, it } from "vitest";
import { createSSEWriter, encodeSSEEvent, sseResponse } from "@/server/realtime/sse";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

describe("encodeSSEEvent", () => {
  it("formats event/data frames", () => {
    expect(encodeSSEEvent("log", { a: 1 })).toBe('event: log\ndata: {"a":1}\n\n');
  });
});

describe("createSSEWriter", () => {
  it("streams events then closes", async () => {
    const writer = createSSEWriter({ heartbeatMs: 0 });
    writer.send("status", { state: "coding" });
    writer.send("log", "hello");
    writer.close();

    const text = await readAll(writer.stream);
    expect(text).toContain("event: status");
    expect(text).toContain('{"state":"coding"}');
    expect(text).toContain("event: log");
    expect(text).toContain('"hello"');
  });

  it("ignores sends after close", async () => {
    const writer = createSSEWriter({ heartbeatMs: 0 });
    writer.close();
    expect(() => writer.send("late", 1)).not.toThrow();
  });

  it("supports cancel downstream", async () => {
    const writer = createSSEWriter({ heartbeatMs: 0 });
    writer.send("a", 1);
    const reader = writer.stream.getReader();
    await reader.cancel();
    expect(() => writer.send("b", 2)).not.toThrow();
    expect(() => writer.close()).not.toThrow();
  });
});

describe("sseResponse", () => {
  it("sets SSE headers", () => {
    const writer = createSSEWriter({ heartbeatMs: 0 });
    const res = sseResponse(writer.stream);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toContain("no-cache");
  });
});
