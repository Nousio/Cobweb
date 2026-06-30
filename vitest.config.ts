import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (relativePath: string): string => fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@skillroute/core/db", replacement: fromRoot("./packages/core/src/db/database.ts") },
      { find: "@skillroute/core", replacement: fromRoot("./packages/core/src/index.ts") },
      { find: "@skillroute/daemon/client", replacement: fromRoot("./packages/daemon/src/ipc/client.ts") },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["test/**/*.test.ts", "packages/*/src/index.ts", "packages/*/src/types.ts"],
      thresholds: {
        statements: 70,
        branches: 70,
        functions: 70,
        lines: 70,
      },
    },
  },
});
