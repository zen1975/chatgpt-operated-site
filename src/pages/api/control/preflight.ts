export const prerender = false;
import type { APIRoute } from 'astro';
import { authorizeControlRead } from '@/server/control-plane/auth';
import { controlError } from '@/server/control-plane/http';
import { contractVersion } from '@/server/control-plane/contracts';
import { preflightCommand } from '@/server/control-plane/preflight';
import { SITE_ID } from '@/server/site-identity';

export const POST: APIRoute = async ({ request }) => {
  try {
    await authorizeControlRead(request, 'command:preflight', ['POST']);
    const result = await preflightCommand(await request.json());
    return Response.json({ success: true, siteId: SITE_ID, contractVersion: contractVersion(), preflight: result });
  } catch (error) { return controlError(error); }
};
