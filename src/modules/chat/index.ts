import type { Module } from "../types.js";

export const chatModule: Module = {
  name: "chat",
  description: "General conversation fallback — no tools, Claude handles natively",
  tools: [],
  async executeTool(_name: string, _input: Record<string, unknown>): Promise<unknown> {
    throw new Error("Chat module has no tools");
  },
};
