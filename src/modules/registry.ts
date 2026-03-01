import type Anthropic from "@anthropic-ai/sdk";
import type { AnyModule } from "./types.js";
import { logger } from "../logger.js";

export class ModuleRegistry {
  private modules: AnyModule[] = [];
  private toolToModule = new Map<string, AnyModule>();

  register(module: AnyModule): void {
    this.modules.push(module);
    for (const tool of module.tools) {
      this.toolToModule.set(tool.name, module);
    }
    logger.info(
      { module: module.name, tools: module.tools.map((t) => t.name) },
      "Module registered"
    );
  }

  getToolDefinitions(): Anthropic.Tool[] {
    return this.modules.flatMap((m) => m.tools);
  }

  async executeTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    const module = this.toolToModule.get(name);
    if (!module) {
      throw new Error(`No module found for tool: ${name}`);
    }
    return module.executeTool(name, input);
  }
}
