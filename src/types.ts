import type { z } from "zod";

/**
 * Tool registration callback supplied by the server entrypoint. Handlers return a
 * plain string; the entrypoint wraps it in MCP content and converts thrown errors
 * into isError responses, so individual tools never deal with MCP envelopes.
 */
export type Register = (
  name: string,
  description: string,
  shape: Record<string, z.ZodType>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any) => Promise<string>,
) => void;
