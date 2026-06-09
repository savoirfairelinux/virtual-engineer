import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import reactHooksPlugin from "eslint-plugin-react-hooks";

const backendRules = {
  ...tsPlugin.configs.recommended.rules,
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
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: { "@typescript-eslint": tsPlugin, "react-hooks": reactHooksPlugin },
    rules: {
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
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/explicit-function-return-type": "off",
      "no-console": "off",
    },
  },
];
