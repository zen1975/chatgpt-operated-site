export const prerender = false;
import type { APIRoute } from 'astro';
import { authorizeControlRead } from '@/server/control-plane/auth';
import { controlError, controlNotFound } from '@/server/control-plane/http';
import { discoverAsset } from '@/server/control-plane/discovery';

export const GET: APIRoute = async ({ request, params }) => {
  try {
    await authorizeControlRead(request, 'asset:read');
    const result = await discoverAsset(params.assetId || '');
    return result ? Response.json({ success: true, ...result }) : controlNotFound('ASSET');
  } catch (error) { return controlError(error); }
};
