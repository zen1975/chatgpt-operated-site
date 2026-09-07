export const prerender = false;
import type { APIRoute } from 'astro';
import { authorizeControlRead } from '@/server/control-plane/auth';
import { controlError } from '@/server/control-plane/http';
import { commandCatalog, contractVersion } from '@/server/control-plane/contracts';

export const GET: APIRoute = async ({ request }) => {
  try {
    await authorizeControlRead(request, ['command:read', 'page:read']);
    return Response.json({ success: true, contractVersion: contractVersion(), commands: commandCatalog() });
  } catch (error) { return controlError(error); }
};
