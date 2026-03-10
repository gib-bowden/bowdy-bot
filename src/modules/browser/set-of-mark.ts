import type { Page } from "playwright-core";
import { logger } from "../../logger.js";
import { takeScreenshot } from "./actions.js";
import type { A11yElement } from "./types.js";

export async function captureWithLabels(page: Page, elements: A11yElement[]): Promise<Buffer> {
  const labeled = elements.filter((el) => el.bounds);

  // Inject overlay badges
  try {
    await page.evaluate((items: Array<{ label: number; x: number; y: number; width: number; height: number }>) => {
      const COLORS = ["#d32f2f", "#1565c0", "#2e7d32", "#7b1fa2"];
      const BADGE_HEIGHT = 18;
      const BADGE_MIN_WIDTH = 40;
      const placed: Array<{ x: number; y: number }> = [];

      for (const item of items) {
        const color = COLORS[item.label % 4]!;
        let badgeX = item.x;
        let badgeY = Math.max(0, item.y - 16);

        // Collision avoidance: if overlaps a previous badge, position at right edge
        const overlaps = placed.some(
          (p) => Math.abs(p.y - badgeY) < BADGE_HEIGHT && Math.abs(p.x - badgeX) < BADGE_MIN_WIDTH,
        );
        if (overlaps) {
          badgeX = item.x + item.width;
        }
        placed.push({ x: badgeX, y: badgeY });

        const badge = document.createElement("div");
        badge.setAttribute("data-som-label", String(item.label));
        badge.style.position = "fixed";
        badge.style.left = `${badgeX}px`;
        badge.style.top = `${badgeY}px`;
        badge.style.backgroundColor = color;
        badge.style.color = "white";
        badge.style.fontSize = "13px";
        badge.style.fontWeight = "bold";
        badge.style.padding = "1px 4px";
        badge.style.borderRadius = "3px";
        badge.style.zIndex = "999999";
        badge.style.pointerEvents = "none";
        badge.style.lineHeight = "16px";
        badge.style.textShadow = "0 0 2px rgba(0,0,0,0.8)";
        badge.textContent = `[${item.label}]`;
        document.body.appendChild(badge);
      }
    }, labeled.map((el) => ({
      label: el.label,
      x: el.bounds!.x,
      y: el.bounds!.y,
      width: el.bounds!.width,
      height: el.bounds!.height,
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
