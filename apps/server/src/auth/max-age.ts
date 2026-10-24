/**
 * The browser session's max age (B1): the cookie's Max-Age and the payload's
 * `exp - iat`. The one definition: B1's session.ts must import it from here,
 * and the hub caps x-ob-session-exp with it (B10-ws).
 */
export const MAX_AGE_S = 7 * 86400;
