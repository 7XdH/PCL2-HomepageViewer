import globals from "globals";

const common = {
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module"
  },
  linterOptions: {
    reportUnusedDisableDirectives: "warn"
  },
  rules: {
    "no-undef": "error",
    "no-redeclare": "error",
    "no-dupe-keys": "error",
    "no-dupe-args": "error",
    "no-func-assign": "error",
    "no-import-assign": "error",
    "no-cond-assign": "error",
    "no-unreachable": "warn",
    "no-fallthrough": "warn",
    "no-constant-condition": ["warn", { checkLoops: false }],
    "no-empty": ["warn", { allowEmptyCatch: true }],
    "no-self-assign": "warn",
    "no-useless-escape": "warn",
    "valid-typeof": "error",
    "use-isnan": "error",
    eqeqeq: "off",
    curly: ["warn", "multi-line"],
    "no-unused-vars": [
      "warn",
      {
        args: "after-used",
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_"
      }
    ]
  }
};

const browserGlobals = {
  ...globals.browser,
  AbortController: "readonly",
  AbortSignal: "readonly",
  Blob: "readonly",
  DOMParser: "readonly",
  File: "readonly",
  FileReader: "readonly",
  Image: "readonly",
  Response: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  requestAnimationFrame: "readonly",
  cancelAnimationFrame: "readonly"
};

const nodeGlobals = {
  ...globals.node,
  AbortController: "readonly",
  AbortSignal: "readonly",
  fetch: "readonly",
  Headers: "readonly",
  Request: "readonly",
  Response: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly"
};

export default [
  {
    ignores: ["dist/**", "node_modules/**", "test-results/**", "assets/**", ".git/**"]
  },
  {
    ...common,
    files: ["js/**/*.js", "tools/test-suite.js"],
    languageOptions: {
      ...common.languageOptions,
      globals: browserGlobals
    }
  },
  {
    ...common,
    files: ["api/**/*.js", "netlify/functions/**/*.mjs", "server.js", "tools/**/*.mjs", "eslint.config.js"],
    languageOptions: {
      ...common.languageOptions,
      globals: nodeGlobals
    }
  }
];
