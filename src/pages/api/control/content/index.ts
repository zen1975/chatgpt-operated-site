export const prerender = false;
import type { APIRoute } from 'astro';
import { authorizeControlRead } from '@/server/control-plane/auth';
import { controlError } from '@/server/control-plane/http';
import { discoverContent } from '@/server/control-plane/discovery';

export const GET: APIRoute = async ({ request }) => {
  try { await authorizeControlRead(request, 'content:read'); return Response.json({ success: true, ...(await discoverContent(new URL(request.url))) }); }
  catch (error) { return controlError(error); }
};
