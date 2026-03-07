import type Anthropic from "@anthropic-ai/sdk";
import { assertUnreachable, type Module } from "../types.js";
import { startBrowserTask, continueBrowserTask } from "./agent.js";

interface BrowserTaskInput {
  url: string;
  goal: string;
}

interface BrowserTaskContinueInput {
  user_response: string;
}

type BrowserInputs = {
  browser_task: BrowserTaskInput;
  browser_task_continue: BrowserTaskContinueInput;
};

const tools: Anthropic.Tool[] = [
  {
    name: "browser_task",
    description:
      "Open a browser and perform a web task autonomously. Navigates to the URL and uses vision to interact with the page to accomplish the goal. Returns a result when done, or asks for user input if needed. Good for booking appointments, filling forms, checking websites, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The URL to navigate to",
        },
        goal: {
          type: "string",
          description:
            "What to accomplish on the page. Be specific — include names, dates, times, and any details needed to complete the task.",
        },
      },
      required: ["url", "goal"],
    },
  },
  {
    name: "browser_task_continue",
    description:
      "Continue a paused browser task after the user provided requested information. Only use this after browser_task returned a needs_input status.",
    input_schema: {
      type: "object" as const,
      properties: {
        user_response: {
          type: "string",
          description: "The user's response to the browser agent's question",
        },
      },
      required: ["user_response"],
    },
  },
];

export const browserModule: Module<BrowserInputs> = {
  name: "browser",
  description: "Browser automation for web tasks like booking appointments, filling forms, and checking websites",
  tools,
  async executeTool(name, input): Promise<unknown> {
    switch (name) {
      case "browser_task": {
        const { url, goal } = input as BrowserTaskInput;
        return startBrowserTask(url, goal);
      }
      case "browser_task_continue": {
        const { user_response } = input as BrowserTaskContinueInput;
        return continueBrowserTask(user_response);
      }
      default:
        return assertUnreachable(name);
    }
  },
};
