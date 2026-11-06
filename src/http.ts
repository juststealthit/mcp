/**
 * Streamable HTTP transport, for clients that connect over the network instead of launching the server.
 *
 * - Binds to 127.0.0.1 by default. Binding anywhere else needs a bearer token.
 * - Optional bearer auth (`--auth-token` or `STEALTH_MCP_TOKEN`), compared in constant time.
 * - Origin checks against DNS rebinding: a browser request is served only from a loopback origin or one you allow.
 * - Host header checks while bound to loopback.
 * - One MCP session per client (`mcp-session-id`), idle sessions closed, a cap on how many run at once.
 *
 * @module
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import type { StealthContext } from "./context.js";
import { createStealthServer, type StealthServer } from "./server.js";
import { SERVER_NAME, VERSION } from "./version.js";

export interface HttpOptions {
  /** Default 127.0.0.1. */
  host?: string;
  /** Default 8765. `0` picks a free port. */
  port?: number;
  /** Default `/mcp`. */
  path?: string;
  /** Required unless bound to loopback. */
  token?: string;
  /** Extra browser origins allowed besides loopback ones, such as `https://app.example`. */
  allowedOrigins?: string[];
  /** Host header values accepted, when bound beyond loopback. Default: any (the token guards the server). */
  allowedHosts?: string[];
  /** Default 64. */
  maxSessions?: number;
  /** Close a session idle this long, in ms. Default 30 minutes. */
  sessionIdleMs?: number;
  /** Largest request body, in bytes. Default 4 MB. */
  maxBodyBytes?: number;
}

export interface RunningHttpServer {
  url: string;
  server: Server;
  sessions(): number;
  close(): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
export const isLoopback = (host: string) => LOOPBACK_HOSTS.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host);

const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

const sha = (s: string) => createHash("sha256").update(s).digest();

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }
}

async function readBody(req: IncomingMessage, max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw Object.assign(new Error("too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface Session {
  transport: StreamableHTTPServerTransport;
  mcp: StealthServer;
  lastSeen: number;
  /** Requests still open, such as an SSE stream carrying resource updates. A session with one open is in use, not idle. */
  open: number;
}

export async function startHttpServer(ctx: StealthContext, opts: HttpOptions = {}): Promise<RunningHttpServer> {
  const host = opts.host ?? "127.0.0.1";
  const path = opts.path ?? "/mcp";
  const token = opts.token && opts.token.length > 0 ? opts.token : undefined;
  if (!isLoopback(host) && !token) throw new Error(`Refusing to listen on ${host} without a bearer token. Pass --auth-token (or set STEALTH_MCP_TOKEN), or bind to 127.0.0.1.`);
  if (token && token.length < 16) throw new Error("The bearer token must be at least 16 characters.");
  const tokenDigest = token ? sha(token) : null;
  const allowedOrigins = new Set((opts.allowedOrigins ?? []).map((o) => o.replace(/\/+$/, "").toLowerCase()));
  const allowedHosts = opts.allowedHosts?.length ? new Set(opts.allowedHosts.map((h) => h.toLowerCase())) : null;
  const maxSessions = opts.maxSessions ?? 64;
  const idleMs = opts.sessionIdleMs ?? 30 * 60_000;
  const maxBody = opts.maxBodyBytes ?? 4 * 1024 * 1024;
  const sessions = new Map<string, Session>();
  let starting = 0;

  const originAllowed = (origin: string | undefined) => !origin || LOOPBACK_ORIGIN.test(origin) || allowedOrigins.has(origin.toLowerCase());

  const closeSession = async (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    s.mcp.dispose();
    await s.transport.close().catch(() => undefined);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://local");
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;

    if (url.pathname === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", name: SERVER_NAME, version: VERSION }));
      return;
    }
    if (url.pathname !== path) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }

    // DNS rebinding: a loopback server only answers loopback Host headers
    const hostname = hostnameOf(req.headers.host);
    if (isLoopback(host) ? !hostname || !isLoopback(hostname) : allowedHosts && (!hostname || !allowedHosts.has(hostname))) {
      jsonRpcError(res, 403, -32000, "Host not allowed.");
      return;
    }
    if (!originAllowed(origin)) {
      ctx.logger.warn("http request refused: origin not allowed", { origin });
      jsonRpcError(res, 403, -32000, "Origin not allowed.");
      return;
    }
    const cors: Record<string, string> = origin
      ? {
          "access-control-allow-origin": origin,
          "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
          vary: "origin",
        }
      : {};
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-methods": "GET, POST, DELETE",
        "access-control-allow-headers": "content-type, authorization, mcp-session-id, mcp-protocol-version, last-event-id",
        "access-control-max-age": "600",
      });
      res.end();
      return;
    }

    if (tokenDigest) {
      const auth = req.headers.authorization ?? "";
      const given = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() ?? "";
      if (!given || !timingSafeEqual(sha(given), tokenDigest)) {
        jsonRpcError(res, 401, -32001, "Unauthorized.", { "www-authenticate": 'Bearer realm="stealth-mcp"' });
        return;
      }
    }

    let body: unknown;
    if (req.method === "POST") {
      let raw: string;
      try {
        raw = await readBody(req, maxBody);
      } catch (error) {
        jsonRpcError(res, (error as { status?: number }).status ?? 400, -32600, "Request body too large.");
        return;
      }
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        jsonRpcError(res, 400, -32700, "Parse error: the body isn't JSON.");
        return;
      }
    }

    const sid = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sid) ? sid[0] : sid;
    if (sessionId) {
      const s = sessions.get(sessionId);
      if (!s) {
        jsonRpcError(res, 404, -32001, "Session not found. Start a new one.");
        return;
      }
      s.lastSeen = Date.now();
      s.open++;
      res.once("close", () => {
        s.open--;
        s.lastSeen = Date.now();
      });
      await s.transport.handleRequest(req, res, body);
      return;
    }
    if (req.method !== "POST" || !isInitializeRequest(body)) {
      jsonRpcError(res, 400, -32000, "No session: send an initialize request first.");
      return;
    }
    // sessions still initializing count too, so a burst of initialize requests can't overshoot the cap
    if (sessions.size + starting >= maxSessions) {
      jsonRpcError(res, 503, -32000, "Too many sessions open. Try again later.", { "retry-after": "30" });
      return;
    }

    starting++;
    const mcp = createStealthServer(ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, mcp, lastSeen: Date.now(), open: 0 });
        ctx.logger.info("http session opened", { sessions: sessions.size });
      },
      onsessionclosed: (id) => {
        void closeSession(id);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id && sessions.has(id)) {
        sessions.delete(id);
        ctx.logger.info("http session closed", { sessions: sessions.size });
      }
      mcp.dispose();
    };
    try {
      await mcp.server.connect(transport);
      await transport.handleRequest(req, res, body);
    } finally {
      starting--;
      // an initialize the transport turned down (a bad protocol version, a bad header) opened no session: drop its server
      if (!transport.sessionId || !sessions.has(transport.sessionId)) {
        mcp.dispose();
        await transport.close().catch(() => undefined);
      }
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      ctx.logger.error("http request failed", { error: error instanceof Error ? error.message : String(error) });
      jsonRpcError(res, 500, -32603, "Internal error.");
    });
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 0; // SSE streams stay open

  const sweep = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [id, s] of sessions) if (s.open <= 0 && s.lastSeen < cutoff) void closeSession(id);
  }, Math.min(60_000, idleMs));
  sweep.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 8765, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  const shownHost = addr.family === "IPv6" ? `[${addr.address}]` : addr.address;

  return {
    url: `http://${shownHost}:${addr.port}${path}`,
    server,
    sessions: () => sessions.size,
    close: async () => {
      clearInterval(sweep);
      await Promise.all([...sessions.keys()].map(closeSession));
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
