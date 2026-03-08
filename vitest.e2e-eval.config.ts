import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/eval/e2e.test.ts"],
    testTimeout: 300000, // 5 min per test (real browser + real API)
    hookTimeout: 30000,
  },
});
