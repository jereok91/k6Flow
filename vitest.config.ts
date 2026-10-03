import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["apps/web/**/*.test.ts", "packages/shared/**/*.test.ts"],
  },
});
