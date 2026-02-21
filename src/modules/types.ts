import type Anthropic from "@anthropic-ai/sdk";

export interface Module {
  name: string;
  description: string;
  tools: Anthropic.Tool[];
  executeTool(name: string, input: Record<string, unknown>): Promise<unknown>;
}
