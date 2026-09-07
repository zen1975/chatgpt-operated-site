// Loads the real command schemas from src/server so contract tests validate
// against the shipped implementation rather than a hand-written copy.
//
// src/server/command-schema.ts transitively imports `cloudflare:workers`, which
// only exists inside the Workers runtime. The schema definitions themselves do
// not touch that binding, so the module is stubbed at bundle time. Any future
// import that actually reads `env` at module scope will fail loudly here.
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(repoRoot, 'node_modules', '.cache', 'contract-checks');

const workersStub = {
  name: 'cloudflare-workers-stub',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
      path: 'cloudflare:workers',
      namespace: 'cf-stub'
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: 'cf-stub' }, () => ({
      contents: `export const env = new Proxy({}, {
        get(_target, property) {
          throw new Error('cloudflare:workers env.' + String(property) + ' is not available outside the Workers runtime.');
        }
      });`,
      loader: 'js'
    }));
  }
};

const cache = new Map();

/** Bundle a `src/` TypeScript module and import it as ESM in plain Node. */
export async function loadServerModule(relativePath) {
  const existing = cache.get(relativePath);
  if (existing) return existing;

  const name = relativePath.replace(/[^a-z0-9]+/gi, '-');
  const entryFile = path.join(cacheDir, `${name}.entry.ts`);
  const outFile = path.join(cacheDir, `${name}.mjs`);

  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    entryFile,
    `export * from '${path.join(repoRoot, relativePath).split(path.sep).join('/')}';\n`,
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
  cache.set(relativePath, loaded);
  return loaded;
}

export const loadCommandContracts = () => loadServerModule('src/server/command-schema.ts');
export const loadRuleVersion = () => loadServerModule('src/server/rule-version.ts');

export { repoRoot };
