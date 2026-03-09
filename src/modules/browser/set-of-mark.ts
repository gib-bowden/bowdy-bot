import type { Page } from "playwright-core";
import { logger } from "../../logger.js";
import { takeScreenshot } from "./actions.js";
import type { A11yElement } from "./types.js";

export async function captureWithLabels(page: Page, elements: A11yElement[]): Promise<Buffer> {
  const labeled = elements.filter((el) => el.bounds);

  // Inject overlay badges
  try {
    await page.evaluate((items: Array<{ label: number; x: number; y: number }>) => {
      for (const item of items) {
        const badge = document.createElement("div");
        badge.setAttribute("data-som-label", String(item.label));
        badge.style.position = "fixed";
        badge.style.left = `${item.x}px`;
        badge.style.top = `${Math.max(0, item.y - 16)}px`;
        badge.style.backgroundColor = "red";
        badge.style.color = "white";
        badge.style.fontSize = "12px";
        badge.style.fontWeight = "bold";
        badge.style.padding = "1px 4px";
        badge.style.borderRadius = "3px";
        badge.style.zIndex = "999999";
        badge.style.pointerEvents = "none";
        badge.style.lineHeight = "14px";
        badge.textContent = `[${item.label}]`;
        document.body.appendChild(badge);
      }
    }, labeled.map((el) => ({
      label: el.label,
      x: el.bounds!.x,
      y: el.bounds!.y,
    })));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, "Failed to inject SoM overlays, returning plain screenshot");
    return await takeScreenshot(page);
  }

  // Take screenshot, then always remove overlays
  try {
    const screenshot = await takeScreenshot(page);
    return screenshot;
  } finally {
    await page.evaluate(() => {
      const badges = document.querySelectorAll("[data-som-label]");
      for (const badge of badges) {
        badge.remove();
      }
    }).catch(() => {});
  }
}
