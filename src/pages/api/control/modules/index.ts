export const prerender = false;
import type { APIRoute } from 'astro';
import { authorizeControlRead } from '@/server/control-plane/auth';
import { controlError } from '@/server/control-plane/http';
import { allModuleContracts, contractEnvelope } from '@/server/control-plane/contracts';

export const GET: APIRoute = async ({ request }) => {
  try { await authorizeControlRead(request, 'page:read'); return Response.json(contractEnvelope({ modules: allModuleContracts() })); }
  catch (error) { return controlError(error); }
};
