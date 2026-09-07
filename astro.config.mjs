import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'server',
  adapter: cloudflare({ configPath: 'wrangler.jsonc' }),
  trailingSlash: 'always',
  vite: {
    build: { minify: false }
  }
});
