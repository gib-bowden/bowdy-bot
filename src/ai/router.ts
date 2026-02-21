import type Anthropic from "@anthropic-ai/sdk";
import { getClient } from "./client.js";
import type { ModuleRegistry } from "../modules/registry.js";
import type { IncomingMessage, OutgoingMessage } from "../platform/types.js";
import { logger } from "../logger.js";

const SYSTEM_PROMPT = `You are Bowdy Bot, a helpful family assistant for the Bowden household.
You help with tasks, groceries, calendar, and general questions.
Be concise, friendly, and practical. You're talking to family members, so be warm but efficient.
When a user asks you to do something actionable (add a task, check the calendar, etc.), use the available tools.
For general conversation, just respond naturally.`;

const MODEL = "claude-sonnet-4-20250514";

export class AIRouter {
  private registry: ModuleRegistry;

  constructor(registry: ModuleRegistry) {
    this.registry = registry;
  }

  async handle(message: IncomingMessage): Promise<OutgoingMessage> {
    const client = getClient();
    const tools = this.registry.getToolDefinitions();

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: message.text },
    ];

    let response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    // Tool use loop: keep going until Claude stops calling tools
    while (response.stop_reason === "tool_use") {
      const assistantContent = response.content;
      messages.push({ role: "assistant", content: assistantContent });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of assistantContent) {
        if (block.type !== "tool_use") continue;

        logger.info({ tool: block.name, input: block.input }, "Executing tool");

        try {
          const result = await this.registry.executeTool(block.name, block.input as Record<string, unknown>);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        } catch (err) {
          logger.error({ err, tool: block.name }, "Tool execution failed");
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify({ error: String(err) }),
            is_error: true,
          });
        }
      }

      messages.push({ role: "user", content: toolResults });

      response = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });
    }

    // Extract text from final response
    const textBlocks = response.content.filter(
      (block): block is Anthropic.TextBlock => block.type === "text"
    );

    return {
      text: textBlocks.map((b) => b.text).join("\n") || "I'm not sure how to respond to that.",
    };
  }
}
