import globals from 'globals';
import pluginJs from '@eslint/js';

export default [
  { files: ['**/*.js'], languageOptions: { sourceType: 'commonjs' } },
  { languageOptions: { globals: globals.node } },
  { files: ['**/*.test.js', '**/*.spec.js'], languageOptions: { globals: globals.jest } },
  pluginJs.configs.recommended,
];