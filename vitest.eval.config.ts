import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/eval/eval.test.ts"],
    testTimeout: 60000,
  },
});
