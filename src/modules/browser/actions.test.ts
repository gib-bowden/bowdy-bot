import { describe, it, expect } from "vitest";
import { validateUrl } from "./actions.js";

describe("validateUrl", () => {
  it("allows normal http/https URLs", () => {
    expect(validateUrl("https://www.google.com")).toBeNull();
    expect(validateUrl("http://example.com/path?q=1")).toBeNull();
    expect(validateUrl("https://booking.localhoney.com/appointments")).toBeNull();
  });

  it("blocks non-http schemes", () => {
    expect(validateUrl("file:///etc/passwd")).toMatch(/Blocked scheme/);
    expect(validateUrl("javascript:alert(1)")).toMatch(/Blocked scheme/);
    expect(validateUrl("ftp://example.com")).toMatch(/Blocked scheme/);
    expect(validateUrl("data:text/html,<h1>hi</h1>")).toMatch(/Blocked scheme/);
  });

  it("blocks localhost", () => {
    expect(validateUrl("http://localhost")).toMatch(/localhost/);
    expect(validateUrl("http://localhost:3000/admin")).toMatch(/localhost/);
    expect(validateUrl("http://127.0.0.1")).toMatch(/localhost/);
    expect(validateUrl("http://127.0.0.1:8080")).toMatch(/localhost/);
  });

  it("blocks cloud metadata endpoints", () => {
    expect(validateUrl("http://169.254.169.254/latest/meta-data/")).toMatch(/metadata/);
    expect(validateUrl("http://metadata.google.internal/computeMetadata/v1/")).toMatch(/metadata/);
  });

  it("blocks private IP ranges", () => {
    expect(validateUrl("http://10.0.0.1")).toMatch(/private/);
    expect(validateUrl("http://10.255.255.255")).toMatch(/private/);
    expect(validateUrl("http://172.16.0.1")).toMatch(/private/);
    expect(validateUrl("http://172.31.255.255")).toMatch(/private/);
    expect(validateUrl("http://192.168.1.1")).toMatch(/private/);
    expect(validateUrl("http://0.0.0.0")).toMatch(/private/);
  });

  it("allows public IPs that look similar to private ranges", () => {
    expect(validateUrl("http://172.32.0.1")).toBeNull();
    expect(validateUrl("http://192.169.1.1")).toBeNull();
    expect(validateUrl("http://11.0.0.1")).toBeNull();
  });

  it("rejects invalid URLs", () => {
    expect(validateUrl("not a url")).toMatch(/Invalid/);
    expect(validateUrl("")).toMatch(/Invalid/);
  });
});
