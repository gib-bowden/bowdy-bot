import { describe, it, expect, vi } from "vitest";
import { DialogManager } from "./dialog.js";

vi.mock("../../logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function mockDialog(type: string, message: string, defaultValue = "") {
  return {
    type: () => type,
    message: () => message,
    defaultValue: () => defaultValue,
    accept: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn().mockResolvedValue(undefined),
  };
}

function mockPage() {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!handlers[event]) {
        handlers[event] = [];
      }
      handlers[event]!.push(handler);
    },
    emit(event: string, ...args: unknown[]) {
      for (const handler of handlers[event] ?? []) {
        handler(...args);
      }
    },
  };
}

describe("DialogManager", () => {
  it("returns null when no dialog is pending", () => {
    const dm = new DialogManager();
    expect(dm.pending()).toBeNull();
  });

  it("queues a dialog and returns its info via pending()", () => {
    const dm = new DialogManager();
    const page = mockPage();
    dm.attach(page as never);

    const dialog = mockDialog("alert", "Hello world");
    page.emit("dialog", dialog);

    const info = dm.pending();
    expect(info).toEqual({
      type: "alert",
      message: "Hello world",
      defaultValue: "",
    });
  });

  it("accepts a pending dialog", async () => {
    const dm = new DialogManager();
    const page = mockPage();
    dm.attach(page as never);

    const dialog = mockDialog("confirm", "Are you sure?");
    page.emit("dialog", dialog);

    await dm.accept();
    expect(dialog.accept).toHaveBeenCalled();
    expect(dm.pending()).toBeNull();
  });

  it("dismisses a pending dialog", async () => {
    const dm = new DialogManager();
    const page = mockPage();
    dm.attach(page as never);

    const dialog = mockDialog("confirm", "Delete?");
    page.emit("dialog", dialog);

    await dm.dismiss();
    expect(dialog.dismiss).toHaveBeenCalled();
    expect(dm.pending()).toBeNull();
  });

  it("passes prompt text when accepting a prompt dialog", async () => {
    const dm = new DialogManager();
    const page = mockPage();
    dm.attach(page as never);

    const dialog = mockDialog("prompt", "Enter name:", "default");
    page.emit("dialog", dialog);

    await dm.accept("John");
    expect(dialog.accept).toHaveBeenCalledWith("John");
  });

  it("auto-dismisses beforeunload dialogs", () => {
    const dm = new DialogManager();
    const page = mockPage();
    dm.attach(page as never);

    const dialog = mockDialog("beforeunload", "");
    page.emit("dialog", dialog);

    // Should not queue beforeunload
    expect(dm.pending()).toBeNull();
    expect(dialog.accept).toHaveBeenCalled();
  });

  it("throws when accepting with no pending dialog", async () => {
    const dm = new DialogManager();
    await expect(dm.accept()).rejects.toThrow("No pending dialog to accept");
  });

  it("throws when dismissing with no pending dialog", async () => {
    const dm = new DialogManager();
    await expect(dm.dismiss()).rejects.toThrow("No pending dialog to dismiss");
  });

  it("handles multiple dialogs in FIFO order", async () => {
    const dm = new DialogManager();
    const page = mockPage();
    dm.attach(page as never);

    const d1 = mockDialog("alert", "First");
    const d2 = mockDialog("confirm", "Second");
    page.emit("dialog", d1);
    page.emit("dialog", d2);

    expect(dm.pending()?.message).toBe("First");
    await dm.accept();

    expect(dm.pending()?.message).toBe("Second");
    await dm.dismiss();

    expect(dm.pending()).toBeNull();
  });
});
