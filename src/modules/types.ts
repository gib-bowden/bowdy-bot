import type Anthropic from "@anthropic-ai/sdk";

export type ToolInputMap = Record<string, object>;

export interface Module<T extends ToolInputMap = Record<string, Record<string, unknown>>> {
  name: string;
  description: string;
  tools: Anthropic.Tool[];
  executeTool<K extends string & keyof T>(name: K, input: T[K]): Promise<unknown>;
}
