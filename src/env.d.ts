/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

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
