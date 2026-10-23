import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
    { ignores: ['dist', 'node_modules'] },
    js.configs.recommended,
    tseslint.configs.recommended,
    { files: ['src/**', 'tests/**'], languageOptions: { globals: globals.browser } },
    { files: ['*.config.{js,ts}'], languageOptions: { globals: globals.node } },
    prettier,
);
