import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

/**
 * Flat ESLint config (ESLint 9). Lints TypeScript sources only; generated
 * bundles, build output and plain JS tooling are ignored. Rules are the
 * typescript-eslint recommended set, relaxed where the platform adapters
 * legitimately need `any` (injected `tizen.*` / native bridge globals).
 */
export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.js",
      "**/*.mjs",
      "**/*.cjs",
      "apps/**/main.js",
    ],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2020,
      sourceType: "module",
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // Adapters bridge to untyped device globals; `any` is intentional there.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];
