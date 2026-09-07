export const prerender = false;
import type { APIRoute } from 'astro';
import { authorizeControlRead } from '@/server/control-plane/auth';
import { commandContract } from '@/server/control-plane/contracts';
import { controlError, controlNotFound } from '@/server/control-plane/http';

export const GET: APIRoute = async ({ request, params }) => {
  try {
    await authorizeControlRead(request, ['command:read', 'page:read']);
    const contract = commandContract(params.command || '');
    return contract ? Response.json({ success: true, ...contract, contractVersion: (await import('@/server/control-plane/contracts')).contractVersion() }) : controlNotFound('COMMAND_CONTRACT');
  } catch (error) { return controlError(error); }
};
