import siteProfile from '../../config/site-profile.json';
import { CommandError } from './core/errors';

export const SITE_ID = siteProfile.site.id;

/** The Worker, not an external dispatch adapter, is the final site boundary. */
export function assertCommandTargetsThisSite(targetSite: string | undefined) {
  if (!targetSite || targetSite !== SITE_ID) {
    throw new CommandError(
      'USER_CORRECTABLE',
      'COMMAND_TARGET_SITE_MISMATCH',
      'The command targetSite does not match this installation.'
    );
  }
}
