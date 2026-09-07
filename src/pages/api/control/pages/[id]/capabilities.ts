export const prerender = false;
import type { APIRoute } from 'astro';
import { authorizeControlRead } from '@/server/control-plane/auth';
import { controlError, controlNotFound } from '@/server/control-plane/http';
import { contractEnvelope, pageCapabilityContract } from '@/server/control-plane/contracts';
import { readPageById } from '@/server/control-plane/state';

export const GET: APIRoute = async ({ request, params }) => {
  try {
    await authorizeControlRead(request, 'page:read');
    const state = await readPageById(params.id || '');
    if (!state) return controlNotFound('PAGE');
    const capability = pageCapabilityContract(state.page.id, state.page.version, state.page.slug);
    return capability ? Response.json(contractEnvelope({ capability })) : controlNotFound('PAGE_CAPABILITY');
  } catch (error) { return controlError(error); }
};
