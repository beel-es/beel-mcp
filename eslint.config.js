// Flat ESLint config. Type-aware rules are deliberately NOT enabled: they need a
// full program per lint run, which would duplicate the ground `npm run typecheck`
// already covers on both the Node and the Worker configurations.
//
// `no-explicit-any` is an error rather than a warning because the tool surface is
// derived from an OpenAPI document at runtime — `any` there does not just lose a
// type, it loses the only check that the contract and the code still agree.
//
// `noInlineConfig` is what forbids `eslint-disable` comments: a rule silenced in a
// file leaves no trace in CI, so a finding is either fixed or the rule is argued
// out of this file, where the decision is reviewable.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const NODE_GLOBALS = {
  console: 'readonly',
  process: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  fetch: 'readonly',
  Response: 'readonly',
  Request: 'readonly',
  Headers: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  crypto: 'readonly',
  btoa: 'readonly',
  atob: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  structuredClone: 'readonly',
  Buffer: 'readonly',
  ExecutionContext: 'readonly',
};

export default tseslint.config(
  {
    // Generated, vendored or built output: not ours to style.
    ignores: ['dist/**', 'openapi/**', 'src/mcpapp/generated/**', 'node_modules/**'],
  },
  {
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: 'error',
    },
    languageOptions: {
      globals: NODE_GLOBALS,
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
