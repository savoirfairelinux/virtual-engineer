import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/state/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env["DATABASE_PATH"] ?? "./data/virtual-engineer.db",
  },
});
