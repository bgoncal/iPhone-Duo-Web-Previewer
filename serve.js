#!/usr/bin/env node
"use strict";

// Local server for the iPhone Duo Web Previewer.
//
// Serves index.html and demo.html, and reverse-proxies one target site under
// the same origin so the previewer can inject safe areas into any page,
// local or on the internet. No dependencies.
//
//   node serve.js            # http://127.0.0.1:8765/index.html
//   node serve.js 9000       # another port
//
// The previewer picks the target through /__duo/target?url=… whenever the
// typed URL is cross-origin. Every path that is not one of the previewer's own
// files is then forwarded to that site with framing headers removed.

const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = __dirname;
const HOST = "127.0.0.1";
const PORT = Number(process.argv[2]) || 8765;
const VERBOSE = process.argv.includes("--verbose");
const LOCAL_ORIGIN = `http://${HOST}:${PORT}`;

const LOCAL_FILES = new Set(["/index.html", "/demo.html", "/README.md", "/serve.js"]);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
};

// Headers that would stop the site from rendering inside the frame, or that
// only make sense on the original origin.
const STRIP_RESPONSE_HEADERS = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "strict-transport-security",
  "public-key-pins",
  "connection",
  "keep-alive",
  "transfer-encoding",
]);

// Bodies of these types get absolute references to the target rewritten so
// they stay inside the proxy.
const REWRITE_TYPES = /^(text\/html|text\/css|text\/javascript|application\/(x-)?javascript|application\/json|application\/manifest\+json)/i;

let target = null; // URL of the upstream origin, e.g. https://example.com

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

function sendJSON(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function serveFile(res, pathname) {
  const file = path.normalize(path.join(ROOT, pathname));
  if (!file.startsWith(ROOT + path.sep)) return sendText(res, 403, "Forbidden");
  fs.readFile(file, (error, data) => {
    if (error) return sendText(res, 404, `Not found: ${pathname}`);
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
      "content-length": data.length,
      "cache-control": "no-store",
    });
    res.end(data);
  });
}

function setTarget(raw) {
  if (!raw) throw new Error("Missing url parameter");
  let url;
  try { url = new URL(raw); } catch { throw new Error(`Not an absolute URL: ${raw}`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Unsupported scheme: ${url.protocol}`);
  if (url.origin === LOCAL_ORIGIN) throw new Error("That is the previewer's own origin");
  target = new URL(url.origin);
  log(`target → ${target.origin}`);
  return url.pathname + url.search + url.hash;
}

// Text replacements that keep a site's absolute self-references on the local origin.
function rewriteText(text) {
  const t = target;
  const localWs = LOCAL_ORIGIN.replace(/^http/, "ws");
  const targetWs = t.origin.replace(/^http/, "ws");
  return text
    .split(t.origin).join(LOCAL_ORIGIN)
    .split(targetWs).join(localWs)
    .split(t.origin.replace("://", ":\\/\\/")).join(LOCAL_ORIGIN.replace("://", ":\\/\\/"))
    .split(`//${t.host}`).join(`//${HOST}:${PORT}`);
}

function rewriteCookie(cookie) {
  return cookie
    .replace(/;\s*domain=[^;]*/gi, "")
    .replace(/;\s*secure(?=;|$)/gi, "")
    .replace(/;\s*samesite=none/gi, "; SameSite=Lax");
}

function upstreamRequestHeaders(req) {
  const headers = { ...req.headers };
  headers.host = target.host;
  headers["accept-encoding"] = "identity";
  for (const name of ["origin", "referer"]) {
    if (headers[name]) headers[name] = headers[name].split(LOCAL_ORIGIN).join(target.origin);
  }
  return headers;
}

function upstreamResponseHeaders(upstream) {
  const headers = {};
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (STRIP_RESPONSE_HEADERS.has(name)) continue;
    if (name === "set-cookie") headers[name] = [].concat(value).map(rewriteCookie);
    else if (name === "location" || name === "content-location" || name === "link") headers[name] = rewriteText(value);
    else headers[name] = value;
  }
  return headers;
}

function decoderFor(encoding) {
  switch ((encoding || "").toLowerCase()) {
    case "gzip": case "x-gzip": return zlib.createGunzip();
    case "deflate": return zlib.createInflate();
    case "br": return zlib.createBrotliDecompress();
    default: return null;
  }
}

function proxy(req, res) {
  const t = target;
  const client = t.protocol === "https:" ? https : http;
  const upstreamReq = client.request({
    protocol: t.protocol,
    hostname: t.hostname,
    port: t.port || (t.protocol === "https:" ? 443 : 80),
    servername: t.protocol === "https:" ? t.hostname : undefined,
    method: req.method,
    path: req.url,
    headers: upstreamRequestHeaders(req),
  }, (upstream) => {
    if (VERBOSE) log(req.method, req.url, "→", upstream.statusCode);
    const headers = upstreamResponseHeaders(upstream);
    const type = upstream.headers["content-type"] || "";
    const rewrite = REWRITE_TYPES.test(type) && req.method !== "HEAD" && upstream.statusCode !== 304;

    if (!rewrite) {
      res.writeHead(upstream.statusCode, headers);
      upstream.pipe(res);
      return;
    }

    delete headers["content-length"];
    delete headers["content-encoding"];
    const decoder = decoderFor(upstream.headers["content-encoding"]);
    const source = decoder ? upstream.pipe(decoder) : upstream;
    const chunks = [];
    source.on("data", (chunk) => chunks.push(chunk));
    source.on("error", (error) => {
      log(`decode error for ${req.url}: ${error.message}`);
      if (!res.headersSent) sendText(res, 502, `Could not decode the response from ${t.origin}: ${error.message}`);
      else res.destroy();
    });
    source.on("end", () => {
      const body = Buffer.from(rewriteText(Buffer.concat(chunks).toString("utf8")), "utf8");
      headers["content-length"] = body.length;
      res.writeHead(upstream.statusCode, headers);
      res.end(body);
    });
  });

  upstreamReq.on("error", (error) => {
    log(`proxy error for ${req.method} ${req.url}: ${error.message}`);
    if (!res.headersSent) {
      sendText(res, 502,
        `The previewer's proxy could not reach ${t.origin}\n\n${error.message}\n\n` +
        `Check that the site is up and reachable from this machine.`);
    } else {
      res.destroy();
    }
  });
  req.on("aborted", () => upstreamReq.destroy());
  req.pipe(upstreamReq);
}

function handleUpgrade(req, socket, head) {
  if (!target) { socket.destroy(); return; }
  const t = target;
  const port = t.port || (t.protocol === "https:" ? 443 : 80);
  const upstream = t.protocol === "https:"
    ? tls.connect({ host: t.hostname, port, servername: t.hostname })
    : net.connect({ host: t.hostname, port });

  const headers = upstreamRequestHeaders(req);
  delete headers["accept-encoding"];
  let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
  for (const [name, value] of Object.entries(headers)) raw += `${name}: ${value}\r\n`;
  raw += "\r\n";

  if (VERBOSE) log("upgrade", req.url);
  upstream.write(raw);
  if (head && head.length) upstream.write(head);
  socket.pipe(upstream);
  upstream.pipe(socket);

  const close = () => { socket.destroy(); upstream.destroy(); };
  upstream.on("error", (error) => { log(`websocket error for ${req.url}: ${error.message}`); close(); });
  socket.on("error", close);
  upstream.on("close", close);
  socket.on("close", close);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, LOCAL_ORIGIN);
  const { pathname } = url;

  if (pathname === "/__duo/health") {
    return sendJSON(res, 200, { ok: true, version: 1, target: target ? target.origin : null });
  }
  if (pathname === "/__duo/target") {
    try {
      const path = setTarget(url.searchParams.get("url"));
      return sendJSON(res, 200, { target: target.origin, path });
    } catch (error) {
      return sendJSON(res, 400, { error: error.message });
    }
  }
  if (pathname === "/__duo/clear") {
    target = null;
    log("target cleared");
    return sendJSON(res, 200, { target: null });
  }
  if (LOCAL_FILES.has(pathname) || pathname.startsWith("/docs/")) return serveFile(res, pathname);
  if (pathname === "/" && !target) {
    res.writeHead(302, { location: "/index.html" });
    return res.end();
  }
  if (!target) {
    return sendText(res, 404,
      `No site is being proxied yet.\n\nOpen ${LOCAL_ORIGIN}/index.html and type a URL in the previewer.`);
  }
  proxy(req, res);
});

server.on("upgrade", handleUpgrade);

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Try: node serve.js ${PORT + 1}`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  console.log(`iPhone Duo Web Previewer\n  ${LOCAL_ORIGIN}/index.html?url=/demo.html\n`);
  console.log("Type any URL in the previewer. Cross-origin sites are proxied through this server so safe areas can be injected.");
  if (VERBOSE) console.log("Verbose logging is on.");
});
