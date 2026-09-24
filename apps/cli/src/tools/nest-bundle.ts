import { z } from "zod";
import { extractBundledNest, loadBundledDocsText } from "../lib/bundle";
import type { NamedTool, ToolContext } from "./types";

const extractSchema = z.object({
  force: z.boolean().optional(),
});

const docsSchema = z.object({});

export function createExtractNestTool(context: ToolContext): NamedTool {
  return [
    "extractNest",
    {
      description:
        "Extract bundled Nest source tree into ./nest in the current working directory.",
      inputSchema: extractSchema,
      execute: async (args: { force?: boolean }) => {
        context.reportProgress("tool:extractNest");
        const result = await extractBundledNest(args);
        context.appendLog(`tool extractNest extractedRoot=${JSON.stringify(result.extractedRoot)}`);
        return result;
      },
    },
  ];
}

export function createGetBundledDocsTool(context: ToolContext): NamedTool {
  return [
    "getBundledDocs",
    {
      description: "Fetch bundled Nest docs text used by Nest CLI.",
      inputSchema: docsSchema,
      execute: () => {
        context.reportProgress("tool:getBundledDocs");
        return { docs: loadBundledDocsText() };
      },
    },
  ];
}
