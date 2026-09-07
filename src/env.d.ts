/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

declare module 'cloudflare:workers' {
  export const env: {
    DB: D1Database;
    ASSETS_BUCKET: R2Bucket;
    COMMAND_HMAC_SECRET: string;
    SITE_ORIGIN: string;
    SITE_TIMEZONE: string;
    GOOGLE_DRIVE_ACCESS_TOKEN?: string;
    GOOGLE_DRIVE_REFRESH_TOKEN?: string;
    GOOGLE_DRIVE_CLIENT_ID?: string;
    GOOGLE_DRIVE_CLIENT_SECRET?: string;
    GENERATED_ARTIFACT_ORIGIN?: string;
    GENERATED_ARTIFACT_TOKEN?: string;
    COMMAND_TRUSTED_SCOPES?: string;
    COMMAND_TRUSTED_ACTOR?: string;
  };
}
