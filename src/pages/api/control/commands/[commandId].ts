export const prerender = false;
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { authorizeControlRead } from '@/server/control-plane/auth';
import { controlError } from '@/server/control-plane/http';

// Lets the dispatch gate tell "this command already ran" from "this command is
// new" without guessing. A command whose dispatch response was lost can then be
// replayed deliberately, instead of the gate either blocking recovery or
// bypassing preflight for command ids it has never seen.
//
// Read-only, and deliberately narrow: status and the recorded result, never the
// stored error internals.
export const GET: APIRoute = async ({ request, params }) => {
  try {
    await authorizeControlRead(request, 'command:read');

    const commandId = String(params.commandId || '');
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(commandId)) {
      return Response.json({ success: false, error: { code: 'COMMAND_ID_INVALID', message: 'commandId is not a valid identifier.' } }, { status: 422 });
    }

    const row = await env.DB.prepare('SELECT command_type,status,result_json,created_at,finished_at FROM jobs WHERE command_id=? LIMIT 1')
      .bind(commandId)
      .first<{ command_type: string; status: string; result_json: string | null; created_at: string; finished_at: string | null }>();

    if (!row) return Response.json({ success: true, commandId, known: false, status: null });

    return Response.json({
      success: true,
      commandId,
      known: true,
      command: row.command_type,
      status: row.status,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
      result: row.status === 'success' && row.result_json ? JSON.parse(row.result_json) : null
    });
  } catch (error) {
    return controlError(error);
  }
};
