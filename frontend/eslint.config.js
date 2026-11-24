import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', '.cert']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  // Node: build config, scripts and `node --test` files.
  {
    files: ['vite.config.js', 'scripts/**/*.{js,mjs}', 'test/**/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  // AudioWorklet scope (interview microphone capture).
  {
    files: ['public/interview-pcm-worklet.js'],
    languageOptions: { globals: { ...globals.audioWorklet } },
  },
  // Service worker scope (web push).
  {
    files: ['public/sw.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
])
