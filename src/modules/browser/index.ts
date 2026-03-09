import type Anthropic from "@anthropic-ai/sdk";
import { assertUnreachable, type Module } from "../types.js";
import { startBrowserTask, continueBrowserTask } from "./agent.js";

interface BrowserTaskInput {
  url?: string;
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
      "Open a real browser to interact with a website — click buttons, fill forms, navigate pages. Use this when the task requires INTERACTING with a site: booking appointments, filling out forms, signing up, checking availability on a booking page, adding items to a cart, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "Starting URL. Omit to start from a search engine — preferred when you don't know the exact site. Let the browser agent search and navigate to the right page.",
        },
        goal: {
          type: "string",
          description:
            "What to accomplish on the page. Be specific — include names, dates, times, and any details needed to complete the task.",
        },
      },
      required: ["goal"],
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
  description:
    "Browser automation for web tasks like booking appointments, filling forms, and checking websites",
  tools,
  async executeTool(name, input): Promise<unknown> {
    switch (name) {
      case "browser_task": {
        const { url = "https://duckduckgo.com", goal } = input as BrowserTaskInput;
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
