import type Anthropic from "@anthropic-ai/sdk";
import { getClient } from "./client.js";
import type { ModuleRegistry } from "../modules/registry.js";
import type { IncomingMessage } from "../platform/types.js";
import { getConversationHistory, saveMessage } from "../db/conversation.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

function getSystemPrompt(): string {
  const now = new Date().toLocaleDateString("en-CA", { timeZone: config.timezone }); // YYYY-MM-DD
  const day = new Date().toLocaleDateString("en-US", { timeZone: config.timezone, weekday: "long" });
  return `You are Bowdy Bot, a helpful family assistant for the Bowden household.
You help with tasks, groceries, calendar, and general questions.
Be concise, friendly, and practical. You're talking to family members, so be warm but efficient.
When a user asks you to do something actionable (add a task, check the calendar, etc.), use the available tools.
For general conversation, just respond naturally.
Today is ${day}, ${now}. The family's timezone is ${config.timezone}.`;
}

const MODEL = "claude-sonnet-4-20250514";

export interface StreamCallbacks {
  onText?: (chunk: string) => void;
  onToolUse?: (toolName: string) => void;
  onComplete?: (fullText: string) => void;
}

export class AIRouter {
  private registry: ModuleRegistry;

  constructor(registry: ModuleRegistry) {
    this.registry = registry;
  }

  async handle(
    message: IncomingMessage,
    callbacks?: StreamCallbacks,
  ): Promise<string> {
    const client = getClient();
    const tools = this.registry.getToolDefinitions();

    // Load conversation history
    const history = await getConversationHistory(message.platformUserId);
    const messages: Anthropic.MessageParam[] = [
      ...history.map((h) => ({ role: h.role, content: h.content }) as Anthropic.MessageParam),
      { role: "user", content: message.text },
    ];

    // Save the user message
    await saveMessage(message.platformUserId, "user", message.text);

    // System prompt with cache control
    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: getSystemPrompt(), cache_control: { type: "ephemeral" } },
    ];

    // Mark last tool for caching (tools are stable across calls)
    const cachedTools = tools.length > 0
      ? tools.map((tool, i) =>
          i === tools.length - 1
            ? { ...tool, cache_control: { type: "ephemeral" as const } }
            : tool,
        )
      : tools;

    let finalText = "";

    // Streaming + tool loop
    let done = false;
    while (!done) {
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: 1024,
        system,
        tools: cachedTools,
        messages,
      });

      const toolUseBlocks: Anthropic.ContentBlock[] = [];
      let currentText = "";

      for await (const event of stream) {
        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            currentText += event.delta.text;
            callbacks?.onText?.(event.delta.text);
          }
        } else if (event.type === "content_block_start") {
          if (event.content_block.type === "tool_use") {
            callbacks?.onToolUse?.(event.content_block.name);
          }
        }
      }

      const response = await stream.finalMessage();

      // Collect full content for message history
      for (const block of response.content) {
        if (block.type === "tool_use") {
          toolUseBlocks.push(block);
        }
      }

      if (response.stop_reason === "tool_use") {
        // Add assistant message with all content
        messages.push({ role: "assistant", content: response.content });

        // Execute tools
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of toolUseBlocks) {
          if (block.type !== "tool_use") continue;
          logger.info({ tool: block.name, input: block.input }, "Executing tool");

          try {
            const result = await this.registry.executeTool(
              block.name,
              block.input as Record<string, unknown>,
            );
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
        // Loop again for Claude's response after tool results
      } else {
        finalText = currentText;
        done = true;
      }
    }

    const responseText = finalText || "I'm not sure how to respond to that.";

    // Save assistant response
    await saveMessage(message.platformUserId, "assistant", responseText);

    callbacks?.onComplete?.(responseText);
    return responseText;
  }
}
