import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import { configPathForAstro } from './scripts/production-config.mjs';

export default defineConfig({
  output: 'server',
  adapter: cloudflare({ configPath: configPathForAstro() }),
  trailingSlash: 'always',
  vite: {
    build: { minify: false }
  }
});
