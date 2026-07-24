import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/admin/ui/**",
        "src/index.ts",
        "src/interfaces.ts",
        "src/state/schema.ts",
        "src/state/migrate.ts",
      ],
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "coverage",
      thresholds: {
        statements: 77,
        branches: 67,
        functions: 82,
        lines: 81,
        "src/admin/adminImageProxy.ts": {
          statements: 90,
          branches: 75,
          functions: 100,
          lines: 91,
        },
        "src/admin/adminServer.ts": {
          statements: 84,
          branches: 85,
          functions: 96,
          lines: 84,
        },
        "src/webhooks/webhookServer.ts": {
          statements: 81,
          branches: 71,
          functions: 96,
          lines: 83,
        },
        "src/utils/gitlabAuth.ts": {
          statements: 63,
          branches: 63,
          functions: 61,
          lines: 66,
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("src", import.meta.url)),
    },
  },
});
