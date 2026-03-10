import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing
vi.mock("../../ai/client.js", () => ({ getClient: vi.fn() }));
vi.mock("../../logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./actor.js", () => ({ executeSubTask: vi.fn() }));
vi.mock("./verifier.js", () => ({ verify: vi.fn() }));

import { runRouterLoop } from "./router.js";
import { getClient } from "../../ai/client.js";
import { executeSubTask } from "./actor.js";
import { verify } from "./verifier.js";
import type { ActorResult, VerifierResult, PageMetadata } from "./types.js";

function mockPage() {
  return {
    url: vi.fn().mockReturnValue("https://example.com"),
    title: vi.fn().mockResolvedValue("Example"),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-screenshot")),
  } as never;
}

function mockClient(responses: Array<{ content: Array<{ type: string; [key: string]: unknown }> }>) {
  let callIndex = 0;
  return {
    messages: {
      create: vi.fn().mockImplementation(() => {
        const response = responses[callIndex];
        if (!response) {
          throw new Error(`Unexpected API call #${callIndex}`);
        }
        callIndex++;
        return Promise.resolve(response);
      }),
    },
  };
}

const defaultMetadata: PageMetadata = { url: "https://example.com", title: "Example" };
const screenshot = Buffer.from("fake-screenshot");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runRouterLoop", () => {
  it("handles signal_done tool call", async () => {
    const client = mockClient([
      {
        content: [
          { type: "text", text: "The task is complete." },
          {
            type: "tool_use",
            id: "call_1",
            name: "signal_done",
            input: { summary: "Successfully completed the goal" },
          },
        ],
      },
    ]);
    vi.mocked(getClient).mockReturnValue(client as never);

    const page = mockPage();
    const { result, progressLog } = await runRouterLoop(page, "test goal", screenshot, defaultMetadata);

    expect(result.status).toBe("done");
    if (result.status === "done") {
      expect(result.summary).toBe("Successfully completed the goal");
    }
    expect(progressLog).toHaveLength(0);
  });

  it("handles signal_needs_input tool call", async () => {
    const client = mockClient([
      {
        content: [
          { type: "text", text: "I need login credentials." },
          {
            type: "tool_use",
            id: "call_1",
            name: "signal_needs_input",
            input: { question: "What is your username and password?" },
          },
        ],
      },
    ]);
    vi.mocked(getClient).mockReturnValue(client as never);

    const page = mockPage();
    const { result } = await runRouterLoop(page, "test goal", screenshot, defaultMetadata);

    expect(result.status).toBe("needs_input");
    if (result.status === "needs_input") {
      expect(result.question).toBe("What is your username and password?");
    }
  });

  it("dispatches subtask to Actor and records success in progress log", async () => {
    const actorResult: ActorResult = {
      status: "success",
      summary: "Clicked the button",
      screenshot: Buffer.from("after-click"),
      metadata: { url: "https://example.com/next", title: "Next Page" },
    };
    vi.mocked(executeSubTask).mockResolvedValue(actorResult);

    const verifierResult: VerifierResult = {
      pass: true,
      description: "Button was clicked, now on next page",
      screenshot: Buffer.from("after-click"),
    };
    vi.mocked(verify).mockResolvedValue(verifierResult);

    const client = mockClient([
      // First iteration: dispatch subtask
      {
        content: [
          { type: "text", text: "I need to click the button." },
          {
            type: "tool_use",
            id: "call_1",
            name: "dispatch_subtask",
            input: {
              instruction: "Click the submit button",
              success_criteria: "Form is submitted and confirmation shown",
            },
          },
        ],
      },
      // Second iteration: signal done
      {
        content: [
          { type: "text", text: "Task complete." },
          {
            type: "tool_use",
            id: "call_2",
            name: "signal_done",
            input: { summary: "Form submitted successfully" },
          },
        ],
      },
    ]);
    vi.mocked(getClient).mockReturnValue(client as never);

    const page = mockPage();
    const { result, progressLog } = await runRouterLoop(page, "submit the form", screenshot, defaultMetadata);

    expect(result.status).toBe("done");
    expect(progressLog).toHaveLength(1);
    expect(progressLog[0]!.outcome).toBe("success");
    expect(progressLog[0]!.stateDescription).toBe("Button was clicked, now on next page");

    // Verify the Actor was called with correct subtask
    expect(executeSubTask).toHaveBeenCalledOnce();
    const subTaskArg = vi.mocked(executeSubTask).mock.calls[0]![1];
    expect(subTaskArg.instruction).toBe("Click the submit button");
    expect(subTaskArg.successCriteria).toBe("Form is submitted and confirmation shown");

    // Verify the Verifier was called
    expect(verify).toHaveBeenCalledOnce();
  });

  it("records failure when Actor escalates", async () => {
    const actorResult: ActorResult = {
      status: "escalate",
      reason: "Cannot find the submit button",
      screenshot: Buffer.from("stuck"),
      metadata: { url: "https://example.com", title: "Example" },
    };
    vi.mocked(executeSubTask).mockResolvedValue(actorResult);

    const client = mockClient([
      // First: dispatch subtask (Actor escalates)
      {
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "dispatch_subtask",
            input: {
              instruction: "Click the submit button",
              success_criteria: "Form submitted",
            },
          },
        ],
      },
      // Second: Router sees the failure and tries a different approach, then signals done
      {
        content: [
          {
            type: "tool_use",
            id: "call_2",
            name: "signal_done",
            input: { summary: "Gave up after escalation" },
          },
        ],
      },
    ]);
    vi.mocked(getClient).mockReturnValue(client as never);

    const page = mockPage();
    const { result, progressLog } = await runRouterLoop(page, "submit form", screenshot, defaultMetadata);

    expect(result.status).toBe("done");
    expect(progressLog).toHaveLength(1);
    expect(progressLog[0]!.outcome).toBe("escalated");
    expect(progressLog[0]!.stateDescription).toBe("Cannot find the submit button");

    // Verifier should NOT be called for escalated results
    expect(verify).not.toHaveBeenCalled();
  });

  it("records failure when verifier says subtask failed", async () => {
    const actorResult: ActorResult = {
      status: "success",
      summary: "Clicked the button",
      screenshot: Buffer.from("after-click"),
      metadata: { url: "https://example.com", title: "Example" },
    };
    vi.mocked(executeSubTask).mockResolvedValue(actorResult);

    const verifierResult: VerifierResult = {
      pass: false,
      description: "Button click had no effect, page unchanged",
      screenshot: Buffer.from("after-click"),
    };
    vi.mocked(verify).mockResolvedValue(verifierResult);

    const client = mockClient([
      {
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "dispatch_subtask",
            input: {
              instruction: "Click submit",
              success_criteria: "Form submitted",
            },
          },
        ],
      },
      {
        content: [
          {
            type: "tool_use",
            id: "call_2",
            name: "signal_done",
            input: { summary: "Could not submit" },
          },
        ],
      },
    ]);
    vi.mocked(getClient).mockReturnValue(client as never);

    const page = mockPage();
    const { result, progressLog } = await runRouterLoop(page, "submit form", screenshot, defaultMetadata);

    expect(result.status).toBe("done");
    expect(progressLog).toHaveLength(1);
    expect(progressLog[0]!.outcome).toBe("failed");
  });

  it("sends tool_choice any to force tool use", async () => {
    const client = mockClient([
      {
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "signal_done",
            input: { summary: "Done" },
          },
        ],
      },
    ]);
    vi.mocked(getClient).mockReturnValue(client as never);

    const page = mockPage();
    await runRouterLoop(page, "test goal", screenshot, defaultMetadata);

    const createCall = vi.mocked(client.messages.create).mock.calls[0]![0] as { tool_choice: { type: string } };
    expect(createCall.tool_choice).toEqual({ type: "any" });
  });

  it("re-prompts when model returns text without tool_use (safety net)", async () => {
    const client = mockClient([
      // First: text only, no tool_use (shouldn't happen with tool_choice: any, but safety net)
      {
        content: [
          { type: "text", text: "Let me think about this..." },
        ],
      },
      // Second: proper tool call
      {
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "signal_done",
            input: { summary: "Done after re-prompt" },
          },
        ],
      },
    ]);
    vi.mocked(getClient).mockReturnValue(client as never);

    const page = mockPage();
    const { result } = await runRouterLoop(page, "test goal", screenshot, defaultMetadata);

    expect(result.status).toBe("done");
    // Should have called the API twice
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  it("hits max iterations and returns max_iterations status", async () => {
    // Return text-only responses to exhaust iterations (safety net at 25)
    const responses = Array.from({ length: 25 }, () => ({
      content: [{ type: "text" as const, text: "Still thinking..." }],
    }));

    const client = mockClient(responses);
    vi.mocked(getClient).mockReturnValue(client as never);

    const page = mockPage();
    const { result } = await runRouterLoop(page, "impossible goal", screenshot, defaultMetadata);

    expect(result.status).toBe("max_iterations");
  });

  it("stops after consecutive stalled subtasks", async () => {
    const failedActorResult: ActorResult = {
      status: "escalate",
      reason: "Could not complete task",
      screenshot: Buffer.from("stuck"),
      metadata: { url: "https://example.com", title: "Example" },
    };
    vi.mocked(executeSubTask).mockResolvedValue(failedActorResult);

    // 3 dispatch_subtask calls — all will escalate, triggering stall detection
    const client = mockClient([
      {
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "dispatch_subtask",
            input: { instruction: "Try approach 1", success_criteria: "Done" },
          },
        ],
      },
      {
        content: [
          {
            type: "tool_use",
            id: "call_2",
            name: "dispatch_subtask",
            input: { instruction: "Try approach 2", success_criteria: "Done" },
          },
        ],
      },
      {
        content: [
          {
            type: "tool_use",
            id: "call_3",
            name: "dispatch_subtask",
            input: { instruction: "Try approach 3", success_criteria: "Done" },
          },
        ],
      },
    ]);
    vi.mocked(getClient).mockReturnValue(client as never);

    const page = mockPage();
    const { result, progressLog, routerIterations } = await runRouterLoop(
      page, "impossible task", screenshot, defaultMetadata,
    );

    expect(result.status).toBe("max_iterations");
    expect(result.summary).toContain("consecutive failed sub-tasks");
    expect(progressLog).toHaveLength(3);
    expect(routerIterations).toBe(3); // Stopped at 3, not 25
  });

  it("resets stall counter after successful subtask", async () => {
    const failResult: ActorResult = {
      status: "escalate",
      reason: "Failed",
      screenshot: Buffer.from("stuck"),
      metadata: { url: "https://example.com", title: "Example" },
    };
    const successResult: ActorResult = {
      status: "success",
      summary: "Worked",
      screenshot: Buffer.from("ok"),
      metadata: { url: "https://example.com/next", title: "Next" },
    };
    const verifierPass: VerifierResult = {
      pass: true,
      description: "Looks good",
      screenshot: Buffer.from("ok"),
    };

    // Fail, fail, succeed (resets), fail, fail, done
    vi.mocked(executeSubTask)
      .mockResolvedValueOnce(failResult)
      .mockResolvedValueOnce(failResult)
      .mockResolvedValueOnce(successResult)
      .mockResolvedValueOnce(failResult)
      .mockResolvedValueOnce(failResult);
    vi.mocked(verify).mockResolvedValue(verifierPass);

    const dispatchResponse = (id: string, instruction: string) => ({
      content: [
        {
          type: "tool_use" as const,
          id,
          name: "dispatch_subtask",
          input: { instruction, success_criteria: "Done" },
        },
      ],
    });

    const client = mockClient([
      dispatchResponse("c1", "Try 1"),   // fail (stalls: 1)
      dispatchResponse("c2", "Try 2"),   // fail (stalls: 2)
      dispatchResponse("c3", "Try 3"),   // success (stalls: 0)
      dispatchResponse("c4", "Try 4"),   // fail (stalls: 1)
      dispatchResponse("c5", "Try 5"),   // fail (stalls: 2)
      {
        content: [
          {
            type: "tool_use" as const,
            id: "c6",
            name: "signal_done",
            input: { summary: "Finished" },
          },
        ],
      },
    ]);
    vi.mocked(getClient).mockReturnValue(client as never);

    const page = mockPage();
    const { result, progressLog } = await runRouterLoop(
      page, "test goal", screenshot, defaultMetadata,
    );

    // Should complete, not stall — because the success in the middle reset the counter
    expect(result.status).toBe("done");
    expect(progressLog).toHaveLength(5);
  });

  it("bubbles up needs_input from Actor", async () => {
    const actorResult: ActorResult = {
      status: "needs_input",
      question: "What is the password?",
      context: "On page: https://example.com/login",
    };
    vi.mocked(executeSubTask).mockResolvedValue(actorResult);

    const client = mockClient([
      {
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "dispatch_subtask",
            input: {
              instruction: "Log in to the site",
              success_criteria: "Logged in successfully",
            },
          },
        ],
      },
    ]);
    vi.mocked(getClient).mockReturnValue(client as never);

    const page = mockPage();
    const { result, progressLog } = await runRouterLoop(page, "log in", screenshot, defaultMetadata);

    expect(result.status).toBe("needs_input");
    if (result.status === "needs_input") {
      expect(result.question).toBe("What is the password?");
    }
    expect(progressLog).toHaveLength(1);
    expect(progressLog[0]!.outcome).toBe("needs_input");
  });

  it("resumes with existing progress log and user response", async () => {
    const client = mockClient([
      {
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "signal_done",
            input: { summary: "Resumed and completed" },
          },
        ],
      },
    ]);
    vi.mocked(getClient).mockReturnValue(client as never);

    const existingLog = [
      {
        stepNumber: 1,
        subTask: "Click login",
        outcome: "needs_input" as const,
        stateDescription: "Need password",
        timestamp: new Date().toISOString(),
      },
    ];

    const page = mockPage();
    const { result, progressLog } = await runRouterLoop(
      page,
      "log in",
      screenshot,
      defaultMetadata,
      { existingProgressLog: existingLog, userResponse: "my-password-123" },
    );

    expect(result.status).toBe("done");
    // Should have the original entry + the user response entry
    expect(progressLog).toHaveLength(2);
    expect(progressLog[1]!.stateDescription).toContain("my-password-123");

    // The system prompt should include existing progress
    const createCall = vi.mocked(client.messages.create).mock.calls[0]![0] as { system: string };
    expect(createCall.system).toContain("Click login");
    expect(createCall.system).toContain("my-password-123");
  });
});
