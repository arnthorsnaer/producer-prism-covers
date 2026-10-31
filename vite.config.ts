import { defineConfig } from 'vite'

// GitHub Pages serves the app from /<repo>/; the dev server stays at /.
export default defineConfig(({ command }) => ({ base: command === 'build' ? '/producer-prism-covers/' : '/' }))
