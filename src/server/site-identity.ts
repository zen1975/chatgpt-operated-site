import siteProfile from '../../config/site-profile.json';

/**
 * The canonical identity of this installation, shared by the Worker and the
 * repository configuration.
 *
 * There is deliberately one definition. A command names the site it is written
 * for, and both ends compare against this same value: the dispatch gate reads
 * `config/site-profile.json` directly, and the Worker reads it through this
 * module at build time. A second, separately maintained copy would be a value
 * nothing checks -- exactly the gap that let a command addressed to one
 * customer be applied to whichever installation the workflow pointed at.
 */
export const SITE_ID: string = siteProfile.site.id;

export class SiteIdentityMismatch extends Error {}

/**
 * A command must name this installation. Enforced in the Worker, before
 * idempotency resolution or any mutation, so it holds for every route into
 * executeCommand and cannot be skipped by a replay.
 */
export function assertCommandTargetsThisSite(targetSite: string | undefined) {
  if (!targetSite) throw new SiteIdentityMismatch('The command does not name a target site.');
  if (targetSite !== SITE_ID) throw new SiteIdentityMismatch(`The command targets "${targetSite}" but this installation is "${SITE_ID}".`);
}
