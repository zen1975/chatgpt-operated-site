export const prerender = false;

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { executeCommand } from '@/server/commands';
import { RULE_VERSION } from '@/server/rule-version';

const EmergencyNewsInput = z.object({
  requestId: z.string().min(8).max(120).regex(/^[A-Za-z0-9._-]+$/),
  title: z.string().min(1).max(80),
  body: z.string().min(1).max(10000),
  slug: z.string().min(1).max(200).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  excerpt: z.string().max(160).optional()
}).strict();

const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

async function hmac(secret: string, body: string, timestamp: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${body}`)
  );
  return [...new Uint8Array(signature)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function blocksFromPlainText(body: string) {
  return body
    .split(/\n\s*\n/)
    .map((content) => content.trim())
    .filter(Boolean)
    .map((content) => ({ type: 'paragraph' as const, content }));
}

export const POST: APIRoute = async ({ request }) => {
  const configured = env as typeof env & { EMERGENCY_NEWS_HMAC_SECRET?: string };
  const secret = configured.EMERGENCY_NEWS_HMAC_SECRET || '';

  if (!secret) {
    return Response.json(
      { success: false, error: { code: 'EMERGENCY_NEWS_DISABLED', message: 'Emergency news control is not configured.' } },
      { status: 503 }
    );
  }

  const body = await request.text();
  const timestamp = request.headers.get('x-emergency-timestamp') || '';
  const signature = request.headers.get('x-emergency-signature') || '';
  const timestampMs = Date.parse(timestamp);

  if (!timestamp || !signature || !Number.isFinite(timestampMs)) {
    return Response.json(
      { success: false, error: { code: 'EMERGENCY_AUTH_REQUIRED', message: 'Emergency authorization is required.' } },
      { status: 401 }
    );
  }

  if (Math.abs(Date.now() - timestampMs) > MAX_TIMESTAMP_SKEW_MS) {
    return Response.json(
      { success: false, error: { code: 'EMERGENCY_AUTH_EXPIRED', message: 'Emergency authorization timestamp is outside the allowed window.' } },
      { status: 401 }
    );
  }

  const expected = await hmac(secret, body, timestamp);
  if (!constantTimeEqual(signature, expected)) {
    return Response.json(
      { success: false, error: { code: 'EMERGENCY_AUTH_INVALID', message: 'Emergency authorization is invalid.' } },
      { status: 401 }
    );
  }

  try {
    const input = EmergencyNewsInput.parse(JSON.parse(body));
    const blocks = blocksFromPlainText(input.body);

    const command = {
      schemaVersion: 1 as const,
      commandId: `emergency-news-${input.requestId}`,
      command: 'create_news' as const,
      issuedAt: timestamp,
      context: {
        ruleVersion: RULE_VERSION,
        targetSite: 'emergency-sheet'
      },
      payload: {
        title: input.title,
        ...(input.slug ? { slug: input.slug } : {}),
        ...(input.excerpt ? { excerpt: input.excerpt } : {}),
        blocks,
        contentType: 'news' as const,
        templateProfile: 'news-default',
        categoryTermIds: [],
        tagTermIds: []
      }
    };

    const result = await executeCommand(command, {
      trustedAuthorization: {
        actor: 'emergency-sheet',
        scopes: ['content:write']
      }
    });

    return Response.json(result);
  } catch (error) {
    const e = error as any;
    return Response.json(
      {
        success: false,
        error: {
          type: e.type || 'USER_CORRECTABLE',
          code: e.code || 'INVALID_EMERGENCY_NEWS',
          message: e.message || 'Emergency news request is invalid.',
          retryable: Boolean(e.retryable),
          details: e.details || null
        }
      },
      { status: e.type === 'FATAL_SYSTEM_ERROR' ? 500 : 400 }
    );
  }
};
