export const prerender = false;
import type { APIRoute } from 'astro';
import { authorizeControlRead } from '@/server/control-plane/auth';
import { controlError, controlNotFound } from '@/server/control-plane/http';
import { contractEnvelope, moduleContract } from '@/server/control-plane/contracts';
import { listPageModuleTypes } from '@/server/page-composition/registry';

export const GET: APIRoute = async ({ request, params }) => {
  try {
    await authorizeControlRead(request, 'page:read');
    const type = params.type || '';
    if (!listPageModuleTypes().includes(type as never)) return controlNotFound('MODULE');
    return Response.json(contractEnvelope({ module: moduleContract(type as never) }));
  } catch (error) { return controlError(error); }
};
