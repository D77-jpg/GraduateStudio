import http from "node:http";
import fs from "node:fs";
import { spawn } from "node:child_process";

// PID1 lifetime is independent of the platform host.
const lifetime = setTimeout(() => process.exit(124), 30 * 60 * 1000);
lifetime.unref();
fs.mkdirSync("/tmp/home/.codex", { recursive: true });
fs.copyFileSync("/config/config.toml", "/tmp/home/.codex/config.toml");
const server = http.createServer((req, res) => {
  const upstream = http.request(
    {
      socketPath: "/broker/api.sock",
      path: req.url,
      method: req.method,
      headers: { "content-type": req.headers["content-type"] ?? "" },
    },
    (response) => {
      res.writeHead(response.statusCode ?? 502, {
        "content-type": response.headers["content-type"] ?? "text/plain",
      });
      response.on("error", () => res.destroy());
      response.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (res.headersSent) res.destroy();
    else res.writeHead(502).end();
  });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
});
server.listen(8080, "127.0.0.1", () => {
  // Codex 0.150.1 can panic EAGAIN while println writes a large event to the
  // Docker pipe. Give native stdout/stderr regular files, then relay raw bytes
  // with Node backpressure. No decoding/re-encoding, discarded frames or host
  // mounts. Spools live only in bounded container tmpfs and are never persisted.
  const directory = fs.mkdtempSync("/tmp/codex-output-");
  const channels = [
    { name: "stdout", sink: process.stdout, limit: 16 * 1024 * 1024, offset: 0 },
    { name: "stderr", sink: process.stderr, limit: 1024 * 1024, offset: 0 },
  ].map((channel) => ({ ...channel, fd: fs.openSync(`${directory}/${channel.name}`, "w+") }));
  let exited = false,
    exitCode = 1,
    pumping = false,
    settled = false,
    failed = false;
  const child = spawn("codex", process.argv.slice(2), {
    stdio: ["ignore", channels[0].fd, channels[1].fd],
    env: { ...process.env, GS_WORKER_TOKEN: "broker-placeholder-not-a-secret" },
  });
  const finish = () => {
    if (settled) return;
    settled = true;
    clearInterval(timer);
    clearInterval(watchdog);
    try {
      for (const channel of channels) fs.closeSync(channel.fd);
      fs.rmSync(directory, { recursive: true, force: true });
    } finally {
      // Success drains writes first; failure always destroys the namespace.
      process.exit(exitCode);
    }
  };
  const terminate = () => {
    if (settled) return;
    failed = true;
    exitCode = 1;
    child.kill("SIGKILL");
    finish();
  };
  process.stdout.on("error", terminate);
  process.stderr.on("error", terminate);
  const pump = async () => {
    if (pumping || settled || failed) return;
    pumping = true;
    try {
      for (const channel of channels) {
        const size = fs.fstatSync(channel.fd).size;
        if (size > channel.limit || size < channel.offset) {
          failed = true;
          exitCode = 1;
          child.kill("SIGKILL");
          throw new Error("output limit");
        }
        while (channel.offset < size) {
          const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size - channel.offset));
          const count = fs.readSync(channel.fd, buffer, 0, buffer.length, channel.offset);
          if (!count) break;
          channel.offset += count;
          await new Promise((resolve, reject) =>
            channel.sink.write(buffer.subarray(0, count), (error) =>
              error ? reject(error) : resolve(),
            ),
          );
        }
      }
      // Recheck offsets after exit: the producer may have appended during an await.
      if (exited && channels.every((channel) => channel.offset === fs.fstatSync(channel.fd).size))
        finish();
    } catch {
      terminate();
    } finally {
      pumping = false;
    }
  };
  let exitedAt = 0;
  let lastProgress = Date.now();
  let lastOffset = 0;
  // Independent of pump: a blocked consumer must not allow unbounded spooling
  // or hold a namespace until the full 30-minute task lifetime.
  const watchdog = setInterval(() => {
    const offset = channels.reduce((sum, channel) => sum + channel.offset, 0);
    if (offset !== lastOffset) {
      lastOffset = offset;
      lastProgress = Date.now();
    }
    if (
      channels.some((channel) => {
        const size = fs.fstatSync(channel.fd).size;
        return size > channel.limit || size < channel.offset;
      }) ||
      (pumping && Date.now() - lastProgress > 30_000) ||
      (exitedAt && Date.now() - exitedAt > 30_000)
    ) {
      terminate();
    }
  }, 100);
  const timer = setInterval(() => void pump(), 20);
  child.on("error", terminate);
  child.on("exit", (code) => {
    exited = true;
    exitedAt = Date.now();
    exitCode = failed ? 1 : (code ?? 1);
    void pump();
  });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
});
