import { CommandEnvelope } from '../command-schema';

// REST is only an adapter. It never writes D1 directly.
export function restToCanonicalCommand(input:unknown) {
  return CommandEnvelope.parse(input);
}
