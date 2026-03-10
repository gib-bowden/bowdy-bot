import type { Page, Locator } from "playwright-core";
import type { A11yElement, StructuralElement } from "./types.js";

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
const MAX_STRUCTURAL = 15;
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

// --- Scroll position ---

export async function getScrollPosition(page: Page): Promise<{ scrollY: number; scrollHeight: number; viewportHeight: number }> {
  return page.evaluate(() => ({
    scrollY: Math.round(window.scrollY),
    scrollHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
  }));
}

export function formatScrollContext(scroll: { scrollY: number; scrollHeight: number; viewportHeight: number }): string {
  const { scrollY, scrollHeight, viewportHeight } = scroll;

  if (scrollHeight <= viewportHeight) {
    return "Viewport: full page visible (no scrollable content)";
  }

  const maxScroll = scrollHeight - viewportHeight;
  if (scrollY <= 0) {
    return `Viewport: top of page (0px / ${scrollHeight}px) — content below`;
  }

  if (scrollY >= maxScroll) {
    return `Viewport: bottom of page (${scrollHeight}px / ${scrollHeight}px)`;
  }

  const pct = Math.round((scrollY / maxScroll) * 100);
  return `Viewport: ${pct}% scrolled (${scrollY}px / ${scrollHeight}px) — content above and below`;
}

// --- Structural elements ---

export async function getStructuralElements(page: Page): Promise<StructuralElement[]> {
  const viewport = page.viewportSize();

  const raw = await page.evaluate(() => {
    const selector = "h1, h2, h3, h4, h5, h6, nav, main, header, footer, [role=navigation], [role=main], [role=banner], [role=contentinfo]";
    const nodes = document.querySelectorAll(selector);
    const results: Array<{ tag: string; text: string; rect: { x: number; y: number; width: number; height: number } }> = [];

    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        continue;
      }
      const tag = node.tagName.toLowerCase();
      let text = "";
      if (tag.match(/^h[1-6]$/)) {
        text = (node.textContent ?? "").trim().slice(0, 80);
      } else {
        // For landmarks, use aria-label or role
        text = node.getAttribute("aria-label") ?? "";
      }
      results.push({
        tag,
        text,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
    }
    return results;
  });

  const elements: StructuralElement[] = [];
  for (const item of raw) {
    // Skip off-screen
    if (viewport && (item.rect.y + item.rect.height < 0 || item.rect.y > viewport.height)) {
      continue;
    }
    elements.push({
      tag: item.tag,
      text: item.text,
      bounds: item.rect,
    });
    if (elements.length >= MAX_STRUCTURAL) {
      break;
    }
  }

  return elements;
}

// --- Page snapshot (combines interactive + structural) ---

export interface PageSnapshot {
  interactive: A11yElement[];
  structural: StructuralElement[];
}

export async function getPageSnapshot(page: Page): Promise<PageSnapshot> {
  const [interactive, structural] = await Promise.all([
    getInteractiveElements(page),
    getStructuralElements(page),
  ]);
  return { interactive, structural };
}

// --- Formatting ---

export function formatA11yTree(elements: A11yElement[], structural?: StructuralElement[]): string {
  if (!structural || structural.length === 0) {
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

  // Merge interactive + structural by y-position
  type Tagged =
    | { kind: "interactive"; el: A11yElement; y: number }
    | { kind: "structural"; el: StructuralElement; y: number };

  const merged: Tagged[] = [];
  for (const el of elements) {
    merged.push({ kind: "interactive", el, y: el.bounds?.y ?? 0 });
  }
  for (const el of structural) {
    merged.push({ kind: "structural", el, y: el.bounds?.y ?? 0 });
  }
  merged.sort((a, b) => a.y - b.y);

  return merged
    .map((item) => {
      if (item.kind === "interactive") {
        const el = item.el;
        let line = `[${el.label}] ${el.role} "${el.name}"`;
        if (el.bounds) {
          line += ` (${Math.round(el.bounds.x)},${Math.round(el.bounds.y)} ${Math.round(el.bounds.width)}x${Math.round(el.bounds.height)})`;
        }
        if (el.href) {
          line += ` → ${el.href}`;
        }
        return line;
      }
      const el = item.el;
      const text = el.text ? ` "${el.text}"` : "";
      return `--- ${el.tag}${text} ---`;
    })
    .join("\n");
}
