import { z } from "zod";
import type { NamedTool, ToolContext } from "./types";

const exitSchema = z.object({
  code: z.number().optional(),
});

export function createExitTool(context: ToolContext): NamedTool {
  return [
    "exitNestCli",
    {
      description:
        "Request Nest CLI process exit after this run. Use only when user explicitly asks to exit.",
      inputSchema: exitSchema,
      execute: (args: { code?: number }) => {
        const code = typeof args?.code === "number" && Number.isFinite(args.code) ? args.code : 0;
        context.runtime.requestedExit = true;
        context.runtime.exitCode = Math.floor(code);
        context.reportProgress(`tool:exitNestCli(${context.runtime.exitCode})`);
        // Forceful termination is intentional for this tool.
        context.forceExitProcess(context.runtime.exitCode);
      },
    },
  ];
}
