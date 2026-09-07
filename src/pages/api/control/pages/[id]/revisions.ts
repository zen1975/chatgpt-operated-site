export const prerender = false;
import type { APIRoute } from 'astro';
import { authorizeControlRead } from '@/server/control-plane/auth';
import { controlError, controlNotFound } from '@/server/control-plane/http';
import { readPageById, readRevisions } from '@/server/control-plane/state';

export const GET: APIRoute = async ({ request, params }) => {
  try {
    await authorizeControlRead(request, 'revision:read');
    const id = params.id || '';
    if (!(await readPageById(id))) return controlNotFound('PAGE');
    return Response.json({ success: true, revisions: await readRevisions('page', id) });
  } catch (error) { return controlError(error); }
};
