import { ControlPlaneAuthError } from './auth';
import { CommandError } from '../core/errors';

export function controlError(error: unknown) {
  if (error instanceof ControlPlaneAuthError) return Response.json({ success: false, error: { code: error.code, message: error.message } }, { status: error.status });
  if (error instanceof CommandError) return Response.json({ success: false, error: { code: error.code, message: error.message, details: error.details } }, { status: error.type === 'CONFLICT' ? 409 : 422 });
  const message = error instanceof Error ? error.message : 'Control Plane read failed.';
  return Response.json({ success: false, error: { code: 'CONTROL_READ_FAILED', message } }, { status: 422 });
}

export function controlNotFound(resource: string) {
  return Response.json({ success: false, error: { code: `${resource}_NOT_FOUND`, message: `${resource} was not found.` } }, { status: 404 });
}
