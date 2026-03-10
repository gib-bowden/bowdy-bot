import { describe, it, expect } from "vitest";
import { matchFieldsToData, type FormField } from "./form-fill.js";

function field(overrides: Partial<FormField> & { selector: string }): FormField {
  return {
    tag: "input",
    type: "text",
    name: "",
    id: "",
    placeholder: "",
    ariaLabel: "",
    labelText: "",
    currentValue: "",
    ...overrides,
  };
}

describe("matchFieldsToData", () => {
  it("matches by exact name", () => {
    const fields = [
      field({ selector: "#f1", name: "first_name" }),
      field({ selector: "#f2", name: "last_name" }),
    ];
    const result = matchFieldsToData(fields, { first_name: "Gib", last_name: "Bowden" });
    expect(result.get("first_name")?.selector).toBe("#f1");
    expect(result.get("last_name")?.selector).toBe("#f2");
  });

  it("matches by exact id", () => {
    const fields = [
      field({ selector: "#email", id: "email" }),
    ];
    const result = matchFieldsToData(fields, { email: "test@example.com" });
    expect(result.get("email")?.selector).toBe("#email");
  });

  it("matches by label text (fuzzy)", () => {
    const fields = [
      field({ selector: "#f1", labelText: "First Name" }),
      field({ selector: "#f2", labelText: "Last Name" }),
    ];
    const result = matchFieldsToData(fields, { first_name: "Gib", last_name: "Bowden" });
    expect(result.get("first_name")?.selector).toBe("#f1");
    expect(result.get("last_name")?.selector).toBe("#f2");
  });

  it("matches by placeholder (fuzzy)", () => {
    const fields = [
      field({ selector: "#f1", placeholder: "Enter your email" }),
    ];
    const result = matchFieldsToData(fields, { email: "test@example.com" });
    expect(result.get("email")?.selector).toBe("#f1");
  });

  it("matches by aria-label", () => {
    const fields = [
      field({ selector: "#f1", ariaLabel: "Phone number" }),
    ];
    const result = matchFieldsToData(fields, { phone: "555-1234" });
    expect(result.get("phone")?.selector).toBe("#f1");
  });

  it("matches by input type inference", () => {
    const fields = [
      field({ selector: "#f1", type: "email" }),
      field({ selector: "#f2", type: "tel" }),
      field({ selector: "#f3", type: "url" }),
    ];
    const result = matchFieldsToData(fields, {
      email: "test@example.com",
      phone: "555-1234",
      website: "https://example.com",
    });
    expect(result.get("email")?.selector).toBe("#f1");
    expect(result.get("phone")?.selector).toBe("#f2");
    expect(result.get("website")?.selector).toBe("#f3");
  });

  it("matches by fuzzy name/id", () => {
    const fields = [
      field({ selector: "#f1", name: "user_email_address" }),
    ];
    const result = matchFieldsToData(fields, { email: "test@example.com" });
    expect(result.get("email")?.selector).toBe("#f1");
  });

  it("uses alias mapping (tel → phone canonical) via data key alias", () => {
    // Data key "tel" is an alias for canonical "phone"; field name contains "phone"
    const fields = [
      field({ selector: "#f1", name: "phone_number" }),
    ];
    const result = matchFieldsToData(fields, { tel: "555-1234" });
    expect(result.get("tel")?.selector).toBe("#f1");
  });

  it("uses alias mapping (fname → first_name canonical) via data key alias", () => {
    const fields = [
      field({ selector: "#f1", name: "first_name" }),
    ];
    const result = matchFieldsToData(fields, { fname: "Gib" });
    expect(result.get("fname")?.selector).toBe("#f1");
  });

  it("reports unmatched keys", () => {
    const fields = [
      field({ selector: "#f1", name: "email" }),
    ];
    const result = matchFieldsToData(fields, { email: "test@example.com", phone: "555-1234" });
    expect(result.has("email")).toBe(true);
    expect(result.has("phone")).toBe(false);
  });

  it("does not reuse a field for multiple keys", () => {
    const fields = [
      field({ selector: "#f1", name: "email" }),
    ];
    const result = matchFieldsToData(fields, { email: "a@b.com", e_mail: "c@d.com" });
    expect(result.size).toBe(1);
    expect(result.get("email")?.selector).toBe("#f1");
  });

  it("prefers exact name match over fuzzy label match", () => {
    const fields = [
      field({ selector: "#fuzzy", labelText: "Email Address" }),
      field({ selector: "#exact", name: "email" }),
    ];
    const result = matchFieldsToData(fields, { email: "test@example.com" });
    expect(result.get("email")?.selector).toBe("#exact");
  });

  it("prefers exact id match over fuzzy name match", () => {
    const fields = [
      field({ selector: "#fuzzy", name: "user_phone_number" }),
      field({ selector: "#exact", id: "phone" }),
    ];
    const result = matchFieldsToData(fields, { phone: "555-1234" });
    expect(result.get("phone")?.selector).toBe("#exact");
  });

  it("prefers label match over type inference", () => {
    const fields = [
      field({ selector: "#by-type", type: "email" }),
      field({ selector: "#by-label", type: "text", labelText: "Email" }),
    ];
    const result = matchFieldsToData(fields, { email: "test@example.com" });
    expect(result.get("email")?.selector).toBe("#by-label");
  });

  it("prefers type inference over fuzzy name match", () => {
    const fields = [
      field({ selector: "#by-fuzzy-name", name: "contact_email_field" }),
      field({ selector: "#by-type", type: "email" }),
    ];
    const result = matchFieldsToData(fields, { email: "test@example.com" });
    expect(result.get("email")?.selector).toBe("#by-type");
  });

  it("handles empty fields array", () => {
    const result = matchFieldsToData([], { email: "test@example.com" });
    expect(result.size).toBe(0);
  });

  it("handles empty data object", () => {
    const fields = [field({ selector: "#f1", name: "email" })];
    const result = matchFieldsToData(fields, {});
    expect(result.size).toBe(0);
  });
});
