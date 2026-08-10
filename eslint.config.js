import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import reactHooksPlugin from "eslint-plugin-react-hooks";

// Type-aware rule set (adds no-floating-promises, no-misused-promises, no-unsafe-*, etc.)
const typeCheckedRules = tsPlugin.configs["recommended-type-checked"].rules;

const backendRules = {
  ...typeCheckedRules,
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
  "@typescript-eslint/explicit-function-return-type": "warn",
  "no-console": "warn",
};

export default [
  {
    files: ["src/**/*.ts"],
    ignores: ["src/admin/ui/**"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: backendRules,
  },
  {
    files: ["src/admin/ui/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.admin-ui.json",
        tsconfigRootDir: import.meta.dirname,
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: { "@typescript-eslint": tsPlugin, "react-hooks": reactHooksPlugin },
    rules: {
      // Type-checked preset intentionally not applied here yet (see eslint.config.js history / M5 follow-up).
      ...tsPlugin.configs.recommended.rules,
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/explicit-function-return-type": "off",
      "no-console": "off",
    },
  },
  {
    files: ["tests/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      // Type-checked preset intentionally not applied here yet (see eslint.config.js history / M5 follow-up).
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/explicit-function-return-type": "off",
      "no-console": "off",
    },
  },
  {
    files: ["tests/unit/admin-ui/**/*.test.ts*"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.admin-ui-tests.json",
        tsconfigRootDir: import.meta.dirname,
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: { "@typescript-eslint": tsPlugin, "react-hooks": reactHooksPlugin },
    rules: {
      // Type-checked preset intentionally not applied here yet (see eslint.config.js history / M5 follow-up).
      ...tsPlugin.configs.recommended.rules,
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/explicit-function-return-type": "off",
      "no-console": "off",
    },
  },
  {
    files: ["agent-worker/src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.agent.json",
        tsconfigRootDir: import.meta.dirname,
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...typeCheckedRules,
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/explicit-function-return-type": "warn",
      "no-console": "warn",
    },
  },
];
