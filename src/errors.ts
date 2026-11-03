/**
 * Typed errors and how they map onto MCP. A tool reports a failure as a result with `isError: true` and a structured `error` the model
 * can act on (its code says whether retrying could help). A resource read or a prompt fails with a JSON-RPC error instead, since those
 * have no result to carry it.
 *
 * @module
 */
import {
  StealthApiError,
  StealthError,
  StealthFeeTooHighError,
  StealthNetworkError,
  StealthTimeoutError,
  StealthTransactionError,
  StealthAbortError,
} from "@juststealthit/sdk";
import { ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { KeystoreError } from "./keystore.js";

/** JSON-RPC code MCP uses for an unknown resource. */
export const RESOURCE_NOT_FOUND = -32002;

/** An error raised by this server on purpose, with a stable code. */
export class StealthMcpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "StealthMcpError";
  }
}

/** Something the caller asked for doesn't exist. */
export class NotFoundError extends StealthMcpError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("not_found", message, details);
  }
}

/** A request this server refuses, for safety or because the input doesn't fit. */
export class RefusedError extends StealthMcpError {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(code, message, details);
  }
}

export interface ErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
  requestId?: string | null;
  retryAfterSec?: number | null;
  details?: Record<string, unknown>;
}

/** The facts of any error, safe to show a client. Unknown errors keep only their message. */
export function describeError(error: unknown): ErrorInfo {
  if (error instanceof StealthMcpError) return { code: error.code, message: error.message, retryable: false, ...(Object.keys(error.details).length ? { details: error.details } : {}) };
  if (error instanceof KeystoreError) return { code: `keystore_${error.code}`, message: error.message, retryable: false };
  if (error instanceof McpError) return { code: `mcp_${error.code}`, message: error.message, retryable: false };
  if (error instanceof StealthApiError) {
    return {
      code: error.code,
      message: error.code === "rate_limited" ? `The API is busy right now${error.retryAfterSec ? `; try again in about ${error.retryAfterSec} s` : ""}.` : error.message,
      retryable: error.retryable,
      status: error.status,
      requestId: error.requestId,
      retryAfterSec: error.retryAfterSec,
      ...(error.issues.length ? { details: { issues: error.issues } } : {}),
    };
  }
  if (error instanceof StealthFeeTooHighError) {
    return { code: error.code, message: error.message, retryable: true, details: { feeBps: error.feeBps, maxFeeBps: error.maxFeeBps } };
  }
  if (error instanceof StealthTransactionError) return { code: error.code, message: error.message, retryable: false, ...(error.signature ? { details: { signature: error.signature } } : {}) };
  if (error instanceof StealthTimeoutError) return { code: error.code, message: error.message, retryable: true, requestId: error.request?.requestId ?? null };
  if (error instanceof StealthNetworkError) return { code: error.code, message: error.message, retryable: true, requestId: error.request?.requestId ?? null };
  if (error instanceof StealthAbortError) return { code: error.code, message: "The request was cancelled.", retryable: false };
  if (error instanceof StealthError) return { code: error.code, message: error.message, retryable: error.retryable };
  if (error instanceof RangeError) return { code: "invalid_input", message: error.message, retryable: false };
  // viem and other libraries: their message is enough, their internals are not
  const message = error instanceof Error ? (error as { shortMessage?: string }).shortMessage ?? error.message : String(error);
  return { code: "internal_error", message, retryable: false };
}

/** A tool failure as MCP wants it: `isError`, a readable line, and the structured facts. */
export function toolError(error: unknown): CallToolResult {
  const info = describeError(error);
  const hint = info.retryable ? " This may pass on a later try." : "";
  return {
    isError: true,
    content: [{ type: "text", text: `Error (${info.code}): ${info.message}${hint}` }],
    structuredContent: { error: info },
  };
}

/** For resource reads and prompts: a JSON-RPC error with the closest standard code. */
export function toMcpError(error: unknown): McpError {
  if (error instanceof McpError) return error;
  const info = describeError(error);
  const data = { code: info.code, ...(info.requestId ? { requestId: info.requestId } : {}) };
  if (info.code === "not_found" || info.status === 404) return new McpError(RESOURCE_NOT_FOUND, info.message, data);
  if (info.code === "invalid_input" || info.code === "invalid_request" || info.status === 400) return new McpError(ErrorCode.InvalidParams, info.message, data);
  if (info.code === "timeout") return new McpError(ErrorCode.RequestTimeout, info.message, data);
  return new McpError(ErrorCode.InternalError, info.message, data);
}
