import { CommandEnvelope } from '../command-schema';

// GitHub command files are only an adapter. Business logic lives in executeCommand().
export function githubFileToCanonicalCommand(input:unknown) {
  return CommandEnvelope.parse(input);
}
