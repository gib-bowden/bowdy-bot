import type { Page } from "playwright-core";
import { logger } from "../../logger.js";

export interface FormField {
  selector: string;
  tag: string; // input, select, textarea
  type: string; // text, email, tel, password, etc.
  name: string;
  id: string;
  placeholder: string;
  ariaLabel: string;
  labelText: string;
  currentValue: string;
  options?: string[]; // for select elements
}

export interface FillResult {
  filled: Array<{ key: string; field: string; value: string }>;
  unmatched: string[];
}

const COMMON_ALIASES: Record<string, string[]> = {
  phone: ["tel", "mobile", "phone_number", "phonenumber", "cell"],
  email: ["e-mail", "email_address", "emailaddress"],
  first_name: ["firstname", "fname", "given_name", "givenname"],
  last_name: ["lastname", "lname", "surname", "family_name", "familyname"],
  name: ["full_name", "fullname"],
  address: ["street", "address1", "street_address", "address_line_1"],
  address2: ["apt", "suite", "unit", "address_line_2"],
  city: ["town"],
  state: ["province", "region"],
  zip: ["postal_code", "postalcode", "zipcode", "zip_code"],
  country: ["nation"],
  card_number: ["cardnumber", "cc_number", "ccnumber"],
  expiry: ["expiration", "exp_date", "expdate"],
  cvv: ["cvc", "security_code", "securitycode"],
  company: ["organization", "org"],
  website: ["url", "homepage"],
  username: ["user_name", "login"],
  password: ["pass", "passwd"],
  message: ["comments", "notes", "description"],
};

// Build reverse lookup: alias → canonical key
const ALIAS_TO_CANONICAL = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(COMMON_ALIASES)) {
  ALIAS_TO_CANONICAL.set(canonical.toLowerCase(), canonical);
  for (const alias of aliases) {
    ALIAS_TO_CANONICAL.set(alias.toLowerCase(), canonical);
  }
}

export async function detectFormFields(page: Page): Promise<FormField[]> {
  return page.evaluate(() => {
    const fields: Array<{
      selector: string;
      tag: string;
      type: string;
      name: string;
      id: string;
      placeholder: string;
      ariaLabel: string;
      labelText: string;
      currentValue: string;
      options?: string[];
    }> = [];

    const elements = document.querySelectorAll("input, select, textarea");

    for (const el of elements) {
      const htmlEl = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

      // Skip hidden/invisible fields
      const style = window.getComputedStyle(htmlEl);
      if (style.display === "none" || style.visibility === "hidden" || htmlEl.type === "hidden") {
        continue;
      }

      // Skip submit/button/reset inputs
      if (htmlEl instanceof HTMLInputElement && ["submit", "button", "reset", "image", "file"].includes(htmlEl.type)) {
        continue;
      }

      const rect = htmlEl.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        continue;
      }

      // Find associated label
      let labelText = "";
      if (htmlEl.id) {
        const label = document.querySelector(`label[for="${CSS.escape(htmlEl.id)}"]`);
        if (label) {
          labelText = (label.textContent ?? "").trim();
        }
      }
      if (!labelText) {
        const parentLabel = htmlEl.closest("label");
        if (parentLabel) {
          labelText = (parentLabel.textContent ?? "").trim();
        }
      }

      // Build a unique selector
      let selector = "";
      if (htmlEl.id) {
        selector = `#${CSS.escape(htmlEl.id)}`;
      } else if (htmlEl.name) {
        selector = `${htmlEl.tagName.toLowerCase()}[name="${CSS.escape(htmlEl.name)}"]`;
      } else {
        // Fallback: nth-of-type based
        const siblings = htmlEl.parentElement?.querySelectorAll(htmlEl.tagName.toLowerCase()) ?? [];
        let idx = 0;
        for (let i = 0; i < siblings.length; i++) {
          if (siblings[i] === htmlEl) {
            idx = i;
            break;
          }
        }
        selector = `${htmlEl.tagName.toLowerCase()}:nth-of-type(${idx + 1})`;
      }

      const field: typeof fields[number] = {
        selector,
        tag: htmlEl.tagName.toLowerCase(),
        type: htmlEl instanceof HTMLInputElement ? htmlEl.type : htmlEl.tagName.toLowerCase(),
        name: htmlEl.name || "",
        id: htmlEl.id || "",
        placeholder: (htmlEl as HTMLInputElement).placeholder || "",
        ariaLabel: htmlEl.getAttribute("aria-label") || "",
        labelText,
        currentValue: htmlEl.value || "",
      };

      // Capture select options
      if (htmlEl instanceof HTMLSelectElement) {
        field.options = Array.from(htmlEl.options).map((o) => o.text || o.value);
      }

      fields.push(field);
    }

    return fields;
  });
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[-_\s]+/g, "_").trim();
}

function fuzzyMatch(fieldText: string, dataKey: string): boolean {
  const normalizedField = normalize(fieldText);
  const normalizedKey = normalize(dataKey);

  // Empty strings never match
  if (!normalizedField || !normalizedKey) {
    return false;
  }

  // Exact match
  if (normalizedField === normalizedKey) {
    return true;
  }

  // Check if field contains the key or vice versa
  if (normalizedField.includes(normalizedKey) || normalizedKey.includes(normalizedField)) {
    return true;
  }

  // Check aliases
  const canonical = ALIAS_TO_CANONICAL.get(normalizedKey);
  if (canonical) {
    const canonicalNorm = normalize(canonical);
    if (normalizedField === canonicalNorm || normalizedField.includes(canonicalNorm)) {
      return true;
    }
  }

  return false;
}

export function matchFieldsToData(
  fields: FormField[],
  data: Record<string, string>,
): Map<string, FormField> {
  const matches = new Map<string, FormField>();
  const usedFields = new Set<string>();

  for (const key of Object.keys(data)) {
    let bestMatch: FormField | null = null;
    let bestPriority = Infinity;

    for (const field of fields) {
      if (usedFields.has(field.selector)) {
        continue;
      }

      let priority = Infinity;

      // Priority 1: exact match on name or id
      if (normalize(field.name) === normalize(key) || normalize(field.id) === normalize(key)) {
        priority = 1;
      }

      // Priority 2: fuzzy match on label, placeholder, or aria-label
      if (
        priority > 2 &&
        (fuzzyMatch(field.labelText, key) ||
        fuzzyMatch(field.placeholder, key) ||
        fuzzyMatch(field.ariaLabel, key))
      ) {
        priority = 2;
      }

      // Priority 3: type-based inference
      if (priority > 3) {
        if (field.type === "email" && normalize(key).includes("email")) {
          priority = 3;
        } else if (field.type === "tel" && (normalize(key).includes("phone") || normalize(key).includes("tel"))) {
          priority = 3;
        } else if (field.type === "url" && (normalize(key).includes("website") || normalize(key).includes("url"))) {
          priority = 3;
        }
      }

      // Priority 4: fuzzy match on name/id
      if (priority > 4 && (fuzzyMatch(field.name, key) || fuzzyMatch(field.id, key))) {
        priority = 4;
      }

      if (priority < bestPriority) {
        bestMatch = field;
        bestPriority = priority;
        if (priority === 1) {
          break; // Can't do better than exact match
        }
      }
    }

    if (bestMatch) {
      matches.set(key, bestMatch);
      usedFields.add(bestMatch.selector);
    }
  }

  return matches;
}

export async function fillForm(
  page: Page,
  data: Record<string, string>,
): Promise<FillResult> {
  const fields = await detectFormFields(page);
  const matches = matchFieldsToData(fields, data);

  const filled: FillResult["filled"] = [];
  const unmatched: string[] = [];

  for (const [key, value] of Object.entries(data)) {
    const field = matches.get(key);
    if (!field) {
      unmatched.push(key);
      continue;
    }

    try {
      if (field.tag === "select") {
        // Try to select by visible text first, then by value
        try {
          await page.selectOption(field.selector, { label: value }, { timeout: 2000 });
        } catch {
          await page.selectOption(field.selector, value, { timeout: 2000 });
        }
      } else {
        await page.fill(field.selector, value, { timeout: 2000 });
      }
      filled.push({
        key,
        field: field.labelText || field.name || field.id || field.selector,
        value,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ key, selector: field.selector, err: message }, "Failed to fill form field");
      unmatched.push(key);
    }
  }

  return { filled, unmatched };
}
