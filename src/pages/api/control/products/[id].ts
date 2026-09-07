export const prerender = false;
import type { APIRoute } from 'astro';
import { authorizeControlRead } from '@/server/control-plane/auth';
import { controlError, controlNotFound } from '@/server/control-plane/http';
import { readProductById } from '@/server/control-plane/state';

export const GET: APIRoute = async ({ request, params }) => {
  try {
    await authorizeControlRead(request, 'product:read');
    const state = await readProductById(params.id || '');
    return state ? Response.json({ success: true, ...state }) : controlNotFound('PRODUCT');
  } catch (error) { return controlError(error); }
};
