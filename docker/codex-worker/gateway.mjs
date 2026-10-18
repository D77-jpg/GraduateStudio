import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import fs from "node:fs";
import { applyUpstreamTimeout, transportFailureCode } from "./transport-policy.mjs";

// Bound orphan credential/process lifetime even if the application disappears.
const lifetime = setTimeout(() => process.exit(124), 35 * 60 * 1000);
lifetime.unref();
// No redirects, CONNECT, caller-selected hosts, caller authorization or ambient proxy.
const origin = new URL(process.env.GS_UPSTREAM);
const key = process.env.GS_BROKER_KEY;
const pinnedIP = process.env.GS_CODEX_UPSTREAM_IP?.trim();
if (pinnedIP && !publicIPv4(pinnedIP)) process.exit(1);
delete process.env.GS_BROKER_KEY;
if (
  origin.protocol !== "https:" ||
  origin.username ||
  origin.password ||
  !key ||
  (net.isIP(origin.hostname) && !publicIPv4(origin.hostname))
)
  process.exit(1);
const limit = 8 * 1024 * 1024;
export function publicIPv4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const [a, b] = ip.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || b === 2)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0)
  );
}
const server = http.createServer((req, res) => {
  if (
    req.method !== "POST" ||
    req.url !== "/responses" ||
    !/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? "")
  ) {
    res.writeHead(403).end();
    req.resume();
    return;
  }
  let bytes = 0;
  const chunks = [];
  req.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > limit) {
      res.writeHead(413).end();
      req.destroy();
    } else chunks.push(chunk);
  });
  req.on("end", () => {
    if (bytes > limit) return;
    const body = Buffer.concat(chunks);
    let failureReported = false;
    const reportFailure = (code) => {
      if (failureReported) return;
      failureReported = true;
      // Fixed codes only: no prompts, body, headers, credentials or raw errors.
      try {
        fs.writeFileSync("/broker/transport-status", code, { mode: 0o600 });
      } catch {
        /* optional diagnostic */
      }
    };
    // Pin each connection to a validated IPv4 address; fail closed on private DNS answers.
    const upstream = https.request(
      {
        protocol: "https:",
        hostname: origin.hostname,
        port: origin.port || 443,
        path: origin.pathname.replace(/\/$/, "") + "/responses",
        method: "POST",
        agent: false,
        family: 4,
        servername: origin.hostname,
        lookup(host, options, callback) {
          const finish = (error, address, family = 4) => {
            if (error || !publicIPv4(address)) callback(new Error("Upstream address denied"));
            else if (options.all) callback(null, [{ address, family }]);
            else callback(null, address, family);
          };
          if (pinnedIP) finish(null, pinnedIP);
          else dns.lookup(host, { family: 4 }, finish);
        },
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: `Bearer ${key}`,
          "content-length": body.length,
        },
      },
      (response) => {
        // Never forward upstream Location, cookies or authentication diagnostics.
        if (response.statusCode !== 200) {
          reportFailure(`UPSTREAM_HTTP_${response.statusCode ?? 0}`);
          response.resume();
          res.writeHead(502).end("Model upstream rejected request");
          return;
        }
        res.writeHead(200, {
          "content-type": response.headers["content-type"] ?? "text/event-stream",
          "cache-control": "no-store",
        });
        response.on("aborted", () => {
          reportFailure("UPSTREAM_STREAM_ABORTED");
          res.destroy();
        });
        response.on("error", () => {
          reportFailure("UPSTREAM_STREAM_ERROR");
          res.destroy();
        });
        response.pipe(res);
      },
    );
    applyUpstreamTimeout(upstream, reportFailure);
    upstream.on("error", (error) => {
      const code = transportFailureCode(error);
      reportFailure(code);
      if (res.headersSent) res.destroy();
      else res.writeHead(502).end(`Model upstream unavailable (${code})`);
    });
    res.on("close", () => upstream.destroy());
    upstream.end(body);
  });
});
server.headersTimeout = 10000;
server.requestTimeout = 120000;
try {
  fs.unlinkSync("/broker/api.sock");
} catch {
  /* fresh volume */
}
server.listen("/broker/api.sock", () => fs.chmodSync("/broker/api.sock", 0o600));
