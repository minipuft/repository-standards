// The type-aware layer of the fleet preset. It needs type information, so the consumer supplies
// `languageOptions.parserOptions.project` (or `projectService`) in its own config; this layer
// sets the parser and the rules and nothing about which tsconfig to read.

import tseslint from "typescript-eslint";

const TYPESCRIPT_FILES = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];

export const typed = [
  {
    name: "fleet/typed",
    files: TYPESCRIPT_FILES,
    plugins: { "@typescript-eslint": tseslint.plugin },
    languageOptions: { parser: tseslint.parser },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/naming-convention": [
        "warn",
        {
          selector: "interface",
          format: null,
          custom: { regex: "^I[A-Z][a-z]", match: false },
        },
        {
          selector: "enum",
          format: null,
          custom: { regex: "^E[A-Z][a-z]", match: false },
        },
        {
          selector: ["variable", "parameter"],
          format: null,
          custom: { regex: "^(str|int|bool|arr)[A-Z]", match: false },
        },
      ],
    },
  },
];

export default typed;
