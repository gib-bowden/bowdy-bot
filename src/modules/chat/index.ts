import type { Module } from "../types.js";

export const chatModule: Module<Record<string, never>> = {
  name: "chat",
  description: "General conversation fallback — no tools, Claude handles natively",
  tools: [],
  async executeTool(_name: never): Promise<unknown> {
    throw new Error("Chat module has no tools");
  },
};
