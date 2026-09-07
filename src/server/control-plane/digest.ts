import { CommandEnvelope } from '../command-schema';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The receipt is binding metadata, not part of the command being attested. */
export function commandForDigest(input: unknown) {
  const command = CommandEnvelope.parse(input);
  const context = { ...command.context } as Record<string, unknown>;
  delete context.preflight;
  return { ...command, context };
}

export function canonicalCommand(input: unknown) {
  return stable(commandForDigest(input));
}

export async function commandDigest(input: unknown) {
  const bytes = new TextEncoder().encode(canonicalCommand(input));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
