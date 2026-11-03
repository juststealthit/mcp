/**
 * Logging that never touches stdout. On the stdio transport stdout carries the protocol, so a stray line there would break the
 * session: every log line goes to stderr, and, when a client is connected, also out as an MCP `notifications/message`.
 *
 * Secrets never reach a log line: values under keys that look like credentials are redacted before anything is written.
 *
 * @module
 */

/** RFC 5424 levels, as MCP uses them. */
export const LOG_LEVELS = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const SEVERITY = new Map<LogLevel, number>(LOG_LEVELS.map((l, i) => [l, i]));

/** A place log records go besides stderr, such as a connected MCP session. */
export type LogSink = (level: LogLevel, message: string, data?: Record<string, unknown>) => void;

const SECRET_KEY = /pass(word|phrase)?|secret|private|token|api[-_]?key|authorization|cookie|seed|mnemonic|ciphertext/i;

/** Deep-copies `value`, replacing anything under a credential-like key with `"[redacted]"`. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return typeof value === "bigint" ? value.toString() : value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
  return out;
}

export interface LoggerOptions {
  /** Lowest level written to stderr. Default `info`. */
  level?: LogLevel;
  /** One JSON object per line instead of plain text. */
  json?: boolean;
  /** Where stderr lines go. Default `process.stderr`. Tests pass their own. */
  write?: (line: string) => void;
}

export class Logger {
  private level: LogLevel;
  private readonly json: boolean;
  private readonly write: (line: string) => void;
  private readonly sinks = new Set<LogSink>();

  constructor(opts: LoggerOptions = {}) {
    this.level = opts.level ?? "info";
    this.json = opts.json ?? false;
    this.write = opts.write ?? ((line) => process.stderr.write(line));
  }

  setLevel(level: LogLevel) {
    this.level = level;
  }

  /** Adds a sink, such as an MCP session. Returns a function that removes it. */
  addSink(sink: LogSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  log(level: LogLevel, message: string, data?: Record<string, unknown>) {
    const safe = data === undefined ? undefined : (redact(data) as Record<string, unknown>);
    if ((SEVERITY.get(level) ?? 0) >= (SEVERITY.get(this.level) ?? 0)) {
      const line = this.json
        ? JSON.stringify({ time: new Date().toISOString(), level, message, ...(safe ? { data: safe } : {}) })
        : `[stealth-mcp] ${level.padEnd(7)} ${message}${safe ? ` ${JSON.stringify(safe)}` : ""}`;
      try {
        this.write(`${line}\n`);
      } catch {
        /* stderr closed: nothing left to tell */
      }
    }
    // each sink applies the level its own client asked for
    for (const sink of this.sinks) {
      try {
        sink(level, message, safe);
      } catch {
        /* a broken session must not break logging */
      }
    }
  }

  debug(message: string, data?: Record<string, unknown>) {
    this.log("debug", message, data);
  }
  info(message: string, data?: Record<string, unknown>) {
    this.log("info", message, data);
  }
  notice(message: string, data?: Record<string, unknown>) {
    this.log("notice", message, data);
  }
  warn(message: string, data?: Record<string, unknown>) {
    this.log("warning", message, data);
  }
  error(message: string, data?: Record<string, unknown>) {
    this.log("error", message, data);
  }
}

export const isLogLevel = (v: unknown): v is LogLevel => typeof v === "string" && (LOG_LEVELS as readonly string[]).includes(v);
