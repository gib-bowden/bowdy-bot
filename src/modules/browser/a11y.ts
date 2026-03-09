import type { Page, Locator } from "playwright-core";
import type { A11yElement } from "./types.js";

type AriaRole = Parameters<Page["getByRole"]>[0];

const INTERACTIVE_ROLES: AriaRole[] = [
  "button",
  "link",
  "textbox",
  "checkbox",
  "combobox",
  "menuitem",
  "tab",
  "radio",
  "slider",
  "option",
];

const MAX_ELEMENTS = 50;
const LOCATOR_TIMEOUT_MS = 500;

async function collectRole(page: Page, role: AriaRole): Promise<A11yElement[]> {
  const locator = page.getByRole(role);
  const count = await locator.count();
  const results: A11yElement[] = [];
  const viewport = page.viewportSize();

  for (let i = 0; i < count; i++) {
    const el: Locator = locator.nth(i);

    let box: { x: number; y: number; width: number; height: number } | null = null;
    try {
      box = await el.boundingBox({ timeout: LOCATOR_TIMEOUT_MS });
    } catch {
      continue;
    }

    if (!box || box.width === 0 || box.height === 0) {
      continue;
    }

    // Skip elements fully off-screen — they won't appear in screenshots
    if (viewport && (box.y + box.height < 0 || box.y > viewport.height || box.x + box.width < 0 || box.x > viewport.width)) {
      continue;
    }

    let name = "";
    try {
      name = await el.getAttribute("aria-label", { timeout: LOCATOR_TIMEOUT_MS }) ?? "";
      if (!name) {
        name = (await el.innerText({ timeout: LOCATOR_TIMEOUT_MS })).trim();
      }
      if (!name) {
        name = await el.getAttribute("title", { timeout: LOCATOR_TIMEOUT_MS }) ?? "";
      }
      if (!name && (role === "textbox" || role === "combobox")) {
        name = await el.getAttribute("placeholder", { timeout: LOCATOR_TIMEOUT_MS }) ?? "";
      }
    } catch {
      // Fallback: no accessible name
    }

    // Truncate long names
    if (name.length > 80) {
      name = name.slice(0, 77) + "...";
    }

    // Extract href for links so the actor can use navigate as a fallback
    let href: string | undefined;
    if (role === "link") {
      try {
        href = (await el.getAttribute("href", { timeout: LOCATOR_TIMEOUT_MS })) ?? undefined;
      } catch {
        // Fallback: no href
      }
    }

    const locatorStr = buildLocator(role, name);

    results.push({
      label: 0, // Will be assigned after sorting
      role,
      name,
      locator: locatorStr,
      bounds: { x: box.x, y: box.y, width: box.width, height: box.height },
      ...(href ? { href } : {}),
    });
  }

  return results;
}

function buildLocator(role: string, name: string): string {
  if (name) {
    return `getByRole('${role}', { name: '${name.replace(/'/g, "\\'")}' })`;
  }
  return `getByRole('${role}')`;
}

export async function getInteractiveElements(page: Page): Promise<A11yElement[]> {
  const allElements: A11yElement[] = [];

  const roleResults = await Promise.all(
    INTERACTIVE_ROLES.map((role) => collectRole(page, role)),
  );

  for (const elements of roleResults) {
    allElements.push(...elements);
  }

  // Sort by viewport position: top-to-bottom, left-to-right
  // All elements have bounds (filtered in collectRole), but TS doesn't know that
  allElements.sort((a, b) => {
    const ay = a.bounds?.y ?? 0;
    const by = b.bounds?.y ?? 0;
    if (Math.abs(ay - by) > 5) {
      return ay - by;
    }
    return (a.bounds?.x ?? 0) - (b.bounds?.x ?? 0);
  });

  // Truncate and assign labels
  const truncated = allElements.slice(0, MAX_ELEMENTS);
  for (let i = 0; i < truncated.length; i++) {
    truncated[i]!.label = i + 1;
  }

  return truncated;
}

export function formatA11yTree(elements: A11yElement[]): string {
  return elements
    .map((el) => {
      let line = `[${el.label}] ${el.role} "${el.name}"`;
      if (el.bounds) {
        line += ` (${Math.round(el.bounds.x)},${Math.round(el.bounds.y)} ${Math.round(el.bounds.width)}x${Math.round(el.bounds.height)})`;
      }
      if (el.href) {
        line += ` → ${el.href}`;
      }
      return line;
    })
    .join("\n");
}
