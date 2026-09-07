export const prerender = false;
import type { APIRoute } from 'astro';
import { authorizeControlRead } from '@/server/control-plane/auth';
import { controlError, controlNotFound } from '@/server/control-plane/http';
import { readPageById } from '@/server/control-plane/state';

export const GET: APIRoute = async ({ request, params }) => {
  try {
    await authorizeControlRead(request, 'page:read');
    const state = await readPageById(params.id || '');
    return state ? Response.json({ success: true, ...state }) : controlNotFound('PAGE');
  } catch (error) { return controlError(error); }
};
