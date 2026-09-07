// Loads the real command schemas from src/server so contract tests validate
// against the shipped implementation rather than a hand-written copy.
//
// src/server/command-schema.ts transitively imports `cloudflare:workers`, which
// only exists inside the Workers runtime. The schema definitions themselves do
// not touch that binding, so the module is stubbed at bundle time. Any future
// import that actually reads `env` at module scope will fail loudly here.
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { repoRoot } from './repo-root.mjs';

const cacheDir = path.join(repoRoot, 'node_modules', '.cache', 'contract-checks');

const workersStub = {
  name: 'cloudflare-workers-stub',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
      path: 'cloudflare:workers',
      namespace: 'cf-stub'
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: 'cf-stub' }, () => ({
      // Tests that exercise real handlers install a runtime on
      // globalThis.__WORKERS_TEST_ENV__; anything else still fails loudly.
      contents: `export const env = new Proxy({}, {
        get(_target, property) {
          const installed = globalThis.__WORKERS_TEST_ENV__;
          if (installed && property in installed) return installed[property];
          throw new Error('cloudflare:workers env.' + String(property) + ' is not available outside the Workers runtime.');
        }
      });`,
      loader: 'js'
    }));
  }
};

const cache = new Map();

/**
 * Bundle a `src/` TypeScript module and import it as ESM in plain Node.
 *
 * `extraExports` is appended to the generated entry. It exists so callers can
 * pull Zod itself out of the *same* bundle: `.meta()` writes into Zod's global
 * registry, and a separately imported copy of Zod has its own registry, so
 * schema generation run against the outer copy silently loses every `.meta()`
 * constraint.
 */
export async function loadServerModule(relativePath, extraExports = '') {
  const cacheKey = `${relativePath}::${extraExports}`;
  const existing = cache.get(cacheKey);
  if (existing) return existing;

  // `node --test` runs each test file in its own process, concurrently. A
  // shared output path lets one process import a bundle another is still
  // writing, which fails only on a cold cache. Each process gets its own file.
  const name = `${cacheKey.replace(/[^a-z0-9]+/gi, '-')}.${process.pid}`;
  const entryFile = path.join(cacheDir, `${name}.entry.ts`);
  const outFile = path.join(cacheDir, `${name}.mjs`);

  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    entryFile,
    `export * from '${path.join(repoRoot, relativePath).split(path.sep).join('/')}';\n${extraExports}`,
    'utf8'
  );

  await build({
    entryPoints: [entryFile],
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
    plugins: [workersStub]
  });

  const loaded = await import(pathToFileURL(outFile).href);
  cache.set(cacheKey, loaded);
  return loaded;
}

export const loadCommandContracts = () =>
  loadServerModule('src/server/command-schema.ts', `export { z } from 'zod';\n`);
export const loadRuleVersion = () => loadServerModule('src/server/rule-version.ts');

export { repoRoot };
