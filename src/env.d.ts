/// <reference types="astro/client" />

// The Cloudflare runtime types this project actually uses.
//
// tsconfig referenced @cloudflare/workers-types, but that package is not
// installed, so every binding resolved to `any` -- and `any` is assignable to
// anything. That is why a raw D1 statement could be passed where a
// NamedStatement was required and the build stayed green while the batch
// received undefined for every caller statement.
//
// Declared here rather than added as a dependency: this is the surface the code
// uses, and making it explicit is what lets the compiler reject the mistake.
type D1Result<T = Record<string, unknown>> = {
  results: T[];
  success: boolean;
  meta: { changes?: number; duration?: number; last_row_id?: number; rows_read?: number; rows_written?: number };
};

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(): Promise<T[]>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

interface R2Object {
  key: string;
  size: number;
  etag: string;
  httpEtag: string;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
  writeHttpMetadata(headers: Headers): void;
}

interface R2ObjectBody extends R2Object {
  body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream | string | null, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<R2Object>;
  delete(key: string | string[]): Promise<void>;
}

interface KVNamespace {
  get(key: string, options?: { type?: 'text' | 'json' }): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
delete(key: string): Promise<void>;
}

declare module 'cloudflare:workers' {
  export const env: {
    // Bindings declared in wrangler.jsonc.
    DB: D1Database;
    ASSETS_BUCKET: R2Bucket;
    SESSION: KVNamespace;
    SITE_ORIGIN: string;
    SITE_TIMEZONE: string;
    // Secrets. Provision with `wrangler secret put`; never commit values.
    COMMAND_HMAC_SECRET: string;
    CONTROL_READ_HMAC_SECRET?: string;
    READINESS_RECEIPT_HMAC_SECRET?: string;
    EMERGENCY_NEWS_HMAC_SECRET?: string;
    CONTROL_READ_SCOPES?: string;
    GOOGLE_DRIVE_ACCESS_TOKEN?: string;
    GOOGLE_DRIVE_REFRESH_TOKEN?: string;
    GOOGLE_DRIVE_CLIENT_ID?: string;
    GOOGLE_DRIVE_CLIENT_SECRET?: string;
    GOOGLE_DRIVE_SA_CLIENT_EMAIL?: string;
    GOOGLE_DRIVE_SA_PRIVATE_KEY?: string;
    WORDPRESS_ASSET_ALLOWED_ORIGINS?: string;
    GENERATED_ARTIFACT_ORIGIN?: string;
    GENERATED_ARTIFACT_TOKEN?: string;
    COMMAND_TRUSTED_SCOPES?: string;
    COMMAND_TRUSTED_ACTOR?: string;
  };
}
