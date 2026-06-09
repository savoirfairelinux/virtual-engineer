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
          lines: 95,
          branches: 95,
          functions: 95,
          statements: 95,
      },
    },
  },
  resolve: {
    alias: {
    "@": fileURLToPath(new URL("src", import.meta.url)),
    },
  },
});
