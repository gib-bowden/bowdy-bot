import type Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaSkillParams,
  BetaContainerParams,
  BetaToolUnion,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { getClient } from "./client.js";
import type { ModuleRegistry } from "../modules/registry.js";
import type { IncomingMessage } from "../platform/types.js";
import { getConversationHistory, saveMessage } from "../db/conversation.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

function getSystemPrompt(username: string, platform: string): string {
  const now = new Date().toLocaleDateString("en-CA", {
    timeZone: config.timezone,
  }); // YYYY-MM-DD
  const day = new Date().toLocaleDateString("en-US", {
    timeZone: config.timezone,
    weekday: "long",
  });
  const formatting =
    platform === "groupme" || platform === "twilio"
      ? "You are responding in a plain-text chat app. Do NOT use markdown formatting (no **bold**, *italics*, headers, or links). Use plain text only — dashes for lists, ALL CAPS sparingly for emphasis if needed."
      : "";
  const groupChatContext =
    platform === "groupme"
      ? "You are in a family GroupMe group chat. You were summoned because someone addressed you by name. Keep responses concise and relevant — don't be chatty unless asked."
      : "";
  return `You are Bowdy Bot, a helpful family assistant for the Bowden household.
Be concise, friendly, and practical. You're talking to family members, so be warm but efficient.
Use the available tools when a user asks you to do something actionable. For general conversation, just respond naturally.
Today is ${day}, ${now}. The family's timezone is ${config.timezone}.
You are currently talking to ${username}.${formatting ? "\n" + formatting : ""}${groupChatContext ? "\n" + groupChatContext : ""}`;
}

const MODEL = "claude-sonnet-4-6";
const SKILL_BETAS: Anthropic.Beta.AnthropicBeta[] = [
  "skills-2025-10-02",
  "code-execution-2025-08-25",
];

export interface StreamCallbacks {
  onText?: (chunk: string) => void;
  onToolUse?: (toolName: string) => void;
  onComplete?: (fullText: string) => void;
}

export class AIRouter {
  private registry: ModuleRegistry;
  private skills: BetaSkillParams[];

  constructor(registry: ModuleRegistry, skills: BetaSkillParams[] = []) {
    this.registry = registry;
    this.skills = skills;
  }

  async handle(
    message: IncomingMessage,
    callbacks?: StreamCallbacks,
  ): Promise<string> {
    const client = getClient();
    const tools = this.registry.getToolDefinitions();

    // Load conversation history
    const history = await getConversationHistory(message.platformUserId);

    // Build user content — text + optional images
    const userContent: Anthropic.ContentBlockParam[] = [];
    if (message.imageUrls?.length) {
      for (const url of message.imageUrls) {
        userContent.push({ type: "image", source: { type: "url", url } });
      }
    }
    userContent.push({ type: "text", text: message.text || "What's in this image?" });

    const messages: Anthropic.MessageParam[] = [
      ...history.map(
        (h) => ({ role: h.role, content: h.content }) as Anthropic.MessageParam,
      ),
      { role: "user", content: userContent },
    ];

    // Save the user message
    await saveMessage(message.platformUserId, "user", message.text);

    // System prompt with cache control
    const system: Anthropic.TextBlockParam[] = [
      {
        type: "text",
        text: getSystemPrompt(message.platformUsername, message.platform),
        cache_control: { type: "ephemeral" },
      },
    ];

    // Web search server tool — executed server-side by Anthropic
    const webSearchTool: Anthropic.WebSearchTool20250305 = {
      type: "web_search_20250305",
      name: "web_search",
      user_location: {
        type: "approximate",
        region: "Texas",
        country: "US",
        timezone: config.timezone,
      },
    };

    // Build tools array: module tools + code execution (if skills) + web search
    const betaTools: BetaToolUnion[] = [
      ...tools.map((tool, i) =>
        i === tools.length - 1
          ? { ...tool, cache_control: { type: "ephemeral" as const } }
          : tool,
      ),
      ...(this.skills.length > 0
        ? [{ type: "code_execution_20250522" as const, name: "code_execution" as const }]
        : []),
      webSearchTool,
    ];

    // Container config for skills
    let container: BetaContainerParams | string | undefined;
    if (this.skills.length > 0) {
      container = { skills: this.skills };
    }

    let finalText = "";
    let containerId: string | undefined;

    // Streaming + tool loop
    let done = false;
    while (!done) {
      // If we have a container ID from a previous iteration, reuse it
      const containerParam = containerId
        ? containerId
        : container;

      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 2048,
        system,
        tools: betaTools,
        messages,
        ...(this.skills.length > 0 ? { betas: SKILL_BETAS } : {}),
        ...(containerParam ? { container: containerParam } : {}),
      });

      const toolUseBlocks: BetaContentBlock[] = [];
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
          } else if (event.content_block.type === "server_tool_use") {
            callbacks?.onToolUse?.(event.content_block.name);
          }
        }
      }

      const response = await stream.finalMessage();

      // Track container ID for reuse within this conversation turn
      if (response.container?.id) {
        containerId = response.container.id;
      }

      // Collect client-side tool_use blocks (skip server-side results)
      for (const block of response.content) {
        if (block.type === "tool_use") {
          toolUseBlocks.push(block);
        }
      }

      if (response.stop_reason === "tool_use") {
        // Add assistant message with all content
        messages.push({ role: "assistant", content: response.content as Anthropic.ContentBlock[] });

        // Execute tools
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of toolUseBlocks) {
          if (block.type !== "tool_use") continue;
          logger.info(
            { tool: block.name, input: block.input },
            "Executing tool",
          );

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
      } else if (response.stop_reason === "pause_turn") {
        // Long-running skill execution paused mid-turn. Text from this iteration
        // was already streamed to the user via onText callbacks, so we just
        // accumulate it into finalText and re-submit with the same container ID
        // to let the model continue where it left off.
        messages.push({ role: "assistant", content: response.content as Anthropic.ContentBlock[] });
        finalText += currentText;
      } else {
        finalText += currentText;
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
