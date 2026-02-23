import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDelete = vi.fn();
const mockPatch = vi.fn();
const mockList = vi.fn();
const mockTasklistsList = vi.fn();
const mockTasklistsDelete = vi.fn();

vi.mock("./client.js", () => ({
  getTasksClient: vi.fn(async () => ({
    tasks: {
      list: mockList,
      delete: mockDelete,
      patch: mockPatch,
    },
    tasklists: {
      list: mockTasklistsList,
      delete: mockTasklistsDelete,
    },
  })),
}));

import { googleTasksModule } from "./index.js";

const TASK_LISTS = [
  { id: "list-1", title: "general" },
  { id: "list-2", title: "grocery" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockTasklistsList.mockResolvedValue({ data: { items: TASK_LISTS } });
});

describe("googleTasksModule.executeTool - delete_task", () => {
  it("returns confirmation prompt without confirm flag", async () => {
    mockList.mockResolvedValueOnce({
      data: { items: [] },
    });
    mockList.mockResolvedValueOnce({
      data: {
        items: [
          { id: "task-1", title: "Buy milk" },
          { id: "task-2", title: "Buy eggs" },
        ],
      },
    });

    const result = await googleTasksModule.executeTool("delete_task", { title: "milk" });

    expect(result).toEqual({
      success: false,
      needs_confirmation: true,
      title: "Buy milk",
      list: "grocery",
      message: expect.stringContaining("Call again with confirm=true"),
    });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("deletes a task by partial match when confirmed", async () => {
    mockList.mockResolvedValueOnce({
      data: { items: [] },
    });
    mockList.mockResolvedValueOnce({
      data: {
        items: [
          { id: "task-1", title: "Buy milk" },
          { id: "task-2", title: "Buy eggs" },
        ],
      },
    });
    mockDelete.mockResolvedValue({});

    const result = await googleTasksModule.executeTool("delete_task", { title: "milk", confirm: true });

    expect(result).toEqual({ success: true, title: "Buy milk", list: "grocery" });
    expect(mockDelete).toHaveBeenCalledWith({ tasklist: "list-2", task: "task-1" });
  });

  it("is case-insensitive", async () => {
    mockList.mockResolvedValueOnce({
      data: { items: [{ id: "task-1", title: "Call plumber" }] },
    });
    mockList.mockResolvedValueOnce({ data: { items: [] } });
    mockDelete.mockResolvedValue({});

    const result = await googleTasksModule.executeTool("delete_task", { title: "CALL PLUMBER", confirm: true });

    expect(result).toEqual({ success: true, title: "Call plumber", list: "general" });
  });

  it("returns error when no match found", async () => {
    mockList.mockResolvedValue({ data: { items: [] } });

    const result = await googleTasksModule.executeTool("delete_task", { title: "nonexistent" });

    expect(result).toEqual({ success: false, error: 'No task matching "nonexistent" found' });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("searches completed tasks too", async () => {
    mockList.mockResolvedValueOnce({
      data: { items: [{ id: "task-1", title: "Old task", status: "completed" }] },
    });
    mockList.mockResolvedValueOnce({ data: { items: [] } });
    mockDelete.mockResolvedValue({});

    const result = await googleTasksModule.executeTool("delete_task", { title: "Old task", confirm: true });

    expect(result).toEqual({ success: true, title: "Old task", list: "general" });
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ showCompleted: true, showHidden: true }),
    );
  });

  it("returns ambiguity error when multiple tasks match", async () => {
    mockList.mockResolvedValueOnce({
      data: { items: [{ id: "task-1", title: "Buy milk" }] },
    });
    mockList.mockResolvedValueOnce({
      data: { items: [{ id: "task-2", title: "Buy milk chocolate" }] },
    });

    const result = await googleTasksModule.executeTool("delete_task", { title: "milk" });

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("Multiple tasks match"),
    });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("prefers exact match over partial matches", async () => {
    mockList.mockResolvedValueOnce({
      data: {
        items: [
          { id: "task-1", title: "milk" },
          { id: "task-2", title: "Buy milk" },
        ],
      },
    });
    mockList.mockResolvedValueOnce({ data: { items: [] } });
    mockDelete.mockResolvedValue({});

    const result = await googleTasksModule.executeTool("delete_task", { title: "milk", confirm: true });

    expect(result).toEqual({ success: true, title: "milk", list: "general" });
    expect(mockDelete).toHaveBeenCalledWith({ tasklist: "list-1", task: "task-1" });
  });
});

describe("googleTasksModule.executeTool - complete_task", () => {
  it("completes a task by partial match", async () => {
    mockList.mockResolvedValueOnce({
      data: { items: [{ id: "task-1", title: "Call plumber" }] },
    });
    mockList.mockResolvedValueOnce({ data: { items: [] } });
    mockPatch.mockResolvedValue({});

    const result = await googleTasksModule.executeTool("complete_task", { title: "plumber" });

    expect(result).toEqual({ success: true, title: "Call plumber", list: "general" });
    expect(mockPatch).toHaveBeenCalledWith({
      tasklist: "list-1",
      task: "task-1",
      requestBody: { status: "completed" },
    });
  });

  it("returns ambiguity error when multiple tasks match", async () => {
    mockList.mockResolvedValueOnce({
      data: { items: [{ id: "task-1", title: "Buy milk" }] },
    });
    mockList.mockResolvedValueOnce({
      data: { items: [{ id: "task-2", title: "Buy milk chocolate" }] },
    });

    const result = await googleTasksModule.executeTool("complete_task", { title: "milk" });

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("Multiple tasks match"),
    });
    expect(mockPatch).not.toHaveBeenCalled();
  });
});

describe("googleTasksModule.executeTool - delete_list", () => {
  it("returns confirmation prompt when confirm is not set", async () => {
    mockList.mockResolvedValueOnce({
      data: { items: [{ title: "Buy milk" }, { title: "Buy eggs" }] },
    });

    const result = await googleTasksModule.executeTool("delete_list", { list: "grocery" });

    expect(result).toEqual({
      success: false,
      needs_confirmation: true,
      list: "grocery",
      task_count: 2,
      message: expect.stringContaining("Call again with confirm=true"),
    });
    expect(mockTasklistsDelete).not.toHaveBeenCalled();
  });

  it("returns confirmation prompt when confirm is false", async () => {
    mockList.mockResolvedValueOnce({
      data: { items: [{ title: "Task 1" }] },
    });

    const result = await googleTasksModule.executeTool("delete_list", { list: "general", confirm: false });

    expect(result).toEqual(expect.objectContaining({ needs_confirmation: true }));
    expect(mockTasklistsDelete).not.toHaveBeenCalled();
  });

  it("deletes the list when confirm is true", async () => {
    mockList.mockResolvedValueOnce({
      data: { items: [{ title: "Buy milk" }] },
    });
    mockTasklistsDelete.mockResolvedValue({});

    const result = await googleTasksModule.executeTool("delete_list", { list: "grocery", confirm: true });

    expect(result).toEqual({ success: true, list: "grocery", deleted_tasks: 1 });
    expect(mockTasklistsDelete).toHaveBeenCalledWith({ tasklist: "list-2" });
  });

  it("returns error when list not found", async () => {
    const result = await googleTasksModule.executeTool("delete_list", { list: "nonexistent" });

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining('No list named "nonexistent" found'),
    });
    expect(mockTasklistsDelete).not.toHaveBeenCalled();
  });

  it("reports correct count for empty lists", async () => {
    mockList.mockResolvedValueOnce({ data: { items: [] } });

    const result = await googleTasksModule.executeTool("delete_list", { list: "grocery" });

    expect(result).toEqual(expect.objectContaining({ task_count: 0 }));
  });
});
