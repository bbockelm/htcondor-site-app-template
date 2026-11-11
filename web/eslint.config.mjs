import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { window: 'readonly', document: 'readonly', fetch: 'readonly', FormData: 'readonly', File: 'readonly', FileList: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', Date: 'readonly', console: 'readonly', process: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
