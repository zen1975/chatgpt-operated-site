import ruleVersionConfig from '../../config/rule-version.json';

/**
 * The command rule version is installation configuration, not a code constant.
 * `config/rule-version.json` is the single source of truth: the Worker, the
 * emergency ingress, and the shipped command examples must all agree, and
 * `npm run test:contract` fails the build when they drift apart.
 */
export const RULE_VERSION: string = ruleVersionConfig.version;
