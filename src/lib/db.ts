import { env } from 'cloudflare:workers';
export const db = () => env.DB;
