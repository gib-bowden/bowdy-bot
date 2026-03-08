import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/eval/eval.test.ts", "src/**/eval/e2e.test.ts"],
  },
});
