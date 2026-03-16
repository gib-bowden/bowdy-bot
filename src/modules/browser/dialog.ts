import type { Page, Dialog } from "playwright-core";
import { logger } from "../../logger.js";

export interface DialogInfo {
  type: string;
  message: string;
  defaultValue: string;
}

export class DialogManager {
  private queue: Array<{ dialog: Dialog; info: DialogInfo }> = [];

  attach(page: Page): void {
    page.on("dialog", (dialog) => {
      const type = dialog.type();

      // Auto-dismiss beforeunload — it blocks navigation and is never useful to surface
      if (type === "beforeunload") {
        logger.info("Auto-dismissing beforeunload dialog");
        dialog.accept().catch(() => {});
        return;
      }

      const info: DialogInfo = {
        type,
        message: dialog.message(),
        defaultValue: dialog.defaultValue(),
      };
      logger.info({ type, message: info.message }, "Dialog appeared");
      this.queue.push({ dialog, info });
    });
  }

  pending(): DialogInfo | null {
    if (this.queue.length === 0) {
      return null;
    }
    return this.queue[0]!.info;
  }

  async accept(promptText?: string): Promise<void> {
    const entry = this.queue.shift();
    if (!entry) {
      throw new Error("No pending dialog to accept");
    }
    await entry.dialog.accept(promptText);
    logger.info({ type: entry.info.type }, "Dialog accepted");
  }

  async dismiss(): Promise<void> {
    const entry = this.queue.shift();
    if (!entry) {
      throw new Error("No pending dialog to dismiss");
    }
    await entry.dialog.dismiss();
    logger.info({ type: entry.info.type }, "Dialog dismissed");
  }
}
