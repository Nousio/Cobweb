import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (relativePath: string): string => fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@cobweb/core/db", replacement: fromRoot("./packages/core/src/db/database.ts") },
      { find: "@cobweb/core", replacement: fromRoot("./packages/core/src/index.ts") },
      { find: "@cobweb/daemon/client", replacement: fromRoot("./packages/daemon/src/ipc/client.ts") },
    ],
  },
  test: {
    include: ["packages/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/**/*.test.ts", "packages/*/src/index.ts", "packages/*/src/types.ts"],
      thresholds: {
        statements: 70,
        branches: 70,
        functions: 70,
        lines: 70,
      },
    },
  },
});
