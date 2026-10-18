import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns/promises";
import { pathToFileURL } from "node:url";

const HOSTS = new Set(["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]);
// Well-known public resolvers, contacted by literal IP with the resolver hostname
// as SNI so certificate validation still binds that name. Only used when local
// system DNS does not return a usable public address (intercepted/fake-IP DNS).
const RESOLVERS = [
  { ip: "1.1.1.1", sni: "cloudflare-dns.com", path: "/dns-query" },
  { ip: "8.8.8.8", sni: "dns.google", path: "/resolve" },
];
function dohQuery(resolver, host) {
  return new Promise((resolve) => {
    const request = https.request(
      {
        host: resolver.ip,
        servername: resolver.sni,
        port: 443,
        path: `${resolver.path}?name=${encodeURIComponent(host)}&type=A`,
        method: "GET",
        headers: { accept: "application/dns-json" },
        timeout: 5000,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          resolve([]);
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 64 * 1024) request.destroy();
        });
        response.on("end", () => {
          try {
            const answers = JSON.parse(body).Answer;
            resolve(
              Array.isArray(answers)
                ? answers
                    .filter((a) => a?.type === 1 && typeof a.data === "string")
                    .map((a) => a.data)
                : [],
            );
          } catch {
            resolve([]);
          }
        });
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve([]));
    request.end();
  });
}
/** Trusted DNS path with a public-IPv4 check on every answer; pins win when configured. */
export async function resolvePublicHost(host, pins = {}) {
  if (!HOSTS.has(host)) return null;
  if (pins[host]) return publicIPv4(pins[host]) ? pins[host] : null;
  const local = await dns.lookup(host, { family: 4, all: true }).catch(() => []);
  if (local.length && local.every((a) => publicIPv4(a.address))) return local[0].address;
  for (const resolver of RESOLVERS) {
    const answers = await dohQuery(resolver, host);
    if (answers.length && answers.every(publicIPv4)) return answers[0];
  }
  return null;
}
export function publicIPv4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const [a, b, c] = ip.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || b === 2 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0)
  );
}
export function allowedTarget(authority) {
  if (typeof authority !== "string") return null;
  const match = /^([a-z0-9.-]+):443$/.exec(authority);
  return match && HOSTS.has(match[1]) ? match[1] : null;
}
export function createDependencyProxy(pins = {}) {
  if (
    !pins ||
    typeof pins !== "object" ||
    Array.isArray(pins) ||
    Object.entries(pins).some(([host, ip]) => !HOSTS.has(host) || !publicIPv4(ip))
  )
    throw new Error("Invalid public dependency pin");
  const sockets = new Set();
  let totalBytes = 0;
  const server = http.createServer((req, res) => {
    res.writeHead(403, { connection: "close" }).end();
    req.resume();
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 10000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("connect", async (req, client, head) => {
    const host = allowedTarget(req.url);
    const deny = () => {
      if (!client.destroyed) client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    };
    if (!host || sockets.size > 64 || head.length) {
      deny();
      return;
    }
    client.setTimeout(10000, () => client.destroy());
    try {
      const address = await resolvePublicHost(host, pins);
      // The validated address is pinned into the socket; there is no second lookup.
      if (!address || client.destroyed) {
        deny();
        return;
      }
      const upstream = net.connect({ host: address, port: 443 });
      sockets.add(upstream);
      let connected = false;
      const close = () => {
        upstream.destroy();
        client.destroy();
      };
      upstream.once("close", () => {
        sockets.delete(upstream);
        client.destroy();
      });
      upstream.on("error", close);
      client.once("close", () => upstream.destroy());
      upstream.setTimeout(10000, close);
      upstream.once("connect", () => {
        connected = true;
        client.setTimeout(10 * 60 * 1000, close);
        upstream.setTimeout(10 * 60 * 1000, close);
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        // TLS remains end-to-end. No credential injection, headers or bodies logged.
        const account = (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > 512 * 1024 * 1024) close();
        };
        client.on("data", account);
        upstream.on("data", account);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      client.on("error", () => {
        if (connected) close();
        else upstream.destroy();
      });
    } catch {
      deny();
    }
  });
  return {
    server,
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const proxy = createDependencyProxy(JSON.parse(process.env.GS_DEPENDENCY_PUBLIC_IPS || "{}"));
  const lifetime = setTimeout(
    () => {
      proxy.close();
      process.exit(124);
    },
    30 * 60 * 1000,
  );
  lifetime.unref();
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      proxy.close();
      process.exit(0);
    });
  proxy.server.listen(8080, "0.0.0.0");
}
