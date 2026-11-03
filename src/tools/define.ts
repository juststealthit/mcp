/**
 * The one way tools are registered: zod input and output schemas, annotations, cancellation through the request's `AbortSignal`,
 * structured content mirrored as JSON text for clients that only read text, and every failure turned into a tool error result.
 *
 * @module
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { StealthContext } from "../context.js";
import { describeError, toolError } from "../errors.js";
import { jsonSafe } from "../format.js";

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface ToolEnv {
  ctx: StealthContext;
  server: McpServer;
  /** Fires when the client cancels the call or the session closes. Pass it to every request. */
  signal: AbortSignal;
  extra: Extra;
  /** Reports progress, when the client asked for it. */
  progress(progress: number, total?: number, message?: string): Promise<void>;
}

export interface ToolResult<T> {
  data: T;
  /** One or two plain sentences put before the JSON. */
  summary?: string;
}

export interface ToolSpec<I extends z.ZodRawShape, O extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: I;
  output: O;
  annotations: Omit<ToolAnnotations, "title">;
  run(args: z.infer<z.ZodObject<I>>, env: ToolEnv): Promise<ToolResult<z.infer<z.ZodObject<O>>>>;
}

export const defineTool = <I extends z.ZodRawShape, O extends z.ZodRawShape>(spec: ToolSpec<I, O>) => spec;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolSpec = ToolSpec<any, any>;

/** Reads public data: no side effects, safe to repeat. */
export const READ: Omit<ToolAnnotations, "title"> = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
/** Pure maths, no network. */
export const PURE: Omit<ToolAnnotations, "title"> = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Asks the API or a chain to build a transaction. Moves nothing: the result still has to be signed. */
export const PREPARE: Omit<ToolAnnotations, "title"> = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
/** Signs and sends: spends real money and can't be undone. */
export const SIGN: Omit<ToolAnnotations, "title"> = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

/** The JSON text twin of structured content, kept readable but not wasteful. */
export function renderText(data: unknown, summary?: string): string {
  const json = JSON.stringify(data, null, 1);
  return summary ? `${summary}\n\n${json}` : json;
}

export function registerTool(server: McpServer, ctx: StealthContext, spec: AnyToolSpec) {
  const handler = async (args: unknown, extra: Extra): Promise<CallToolResult> => {
    const started = Date.now();
    const progressToken = extra._meta?.progressToken;
    const env: ToolEnv = {
      ctx,
      server,
      signal: extra.signal,
      extra,
      progress: async (progress, total, message) => {
        if (progressToken === undefined) return;
        await extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress, ...(total !== undefined ? { total } : {}), ...(message ? { message } : {}) } }).catch(() => undefined);
      },
    };
    try {
      const result = await spec.run((args ?? {}) as Record<string, unknown>, env);
      const data = jsonSafe(result.data) as Record<string, unknown>;
      ctx.logger.debug(`tool ${spec.name}`, { ms: Date.now() - started });
      return { content: [{ type: "text", text: renderText(data, result.summary) }], structuredContent: data };
    } catch (error) {
      const info = describeError(error);
      ctx.logger.log(info.code === "internal_error" ? "error" : "info", `tool ${spec.name} failed`, { code: info.code, message: info.message, ms: Date.now() - started });
      return toolError(error);
    }
  };
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.input,
      outputSchema: spec.output,
      annotations: { title: spec.title, ...spec.annotations },
    },
    handler as never,
  );
}
