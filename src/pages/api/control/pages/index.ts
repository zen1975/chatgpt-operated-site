export const prerender = false;
import type { APIRoute } from 'astro';
import { authorizeControlRead } from '@/server/control-plane/auth';
import { controlError } from '@/server/control-plane/http';
import { discoverPages } from '@/server/control-plane/discovery';

export const GET: APIRoute = async ({ request }) => {
  try { await authorizeControlRead(request, 'page:read'); return Response.json({ success: true, ...(await discoverPages(new URL(request.url))) }); }
  catch (error) { return controlError(error); }
};
