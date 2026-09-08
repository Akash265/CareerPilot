// Shared ESLint flat config for the plain TypeScript packages
// (packages/config, packages/db, packages/storage, packages/ai).
// apps/web has its own Next.js-specific config and does not use this file.
import tseslint from "typescript-eslint";

export default tseslint.config(
  tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      // ignoreRestSiblings: the destructure-to-omit-a-key pattern used
      // throughout this repo's negative-test cases (e.g. `const { X, ...rest
      // } = validSource`) intentionally never reads `X` itself -- only
      // `rest`. Without this, every one of those tests trips the rule.
      "@typescript-eslint/no-unused-vars": ["warn", { ignoreRestSiblings: true }],
    },
  },
  {
    ignores: ["migrations/**", "eval/fixtures/**", "eval/expected/**"],
  }
);
