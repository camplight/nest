import type { LlmTool } from "@nest/llm";
import { createAskPasswordTool } from "./ask-password";
import { createExitTool } from "./exit";
import { createGetBundledDocsTool } from "./nest-bundle";
import { createShellTool } from "./shell";
import type { ToolContext } from "./types";

export function createNestCliTools(context: ToolContext): Record<string, LlmTool> {
  const tools = [
    createShellTool(context),
    createAskPasswordTool(context),
    createGetBundledDocsTool(context),
    createExitTool(context),
  ];
  return Object.fromEntries(tools);
}
