/**
 * Input validation for RPC requests. Returns error string if invalid, undefined if ok.
 */

/** Max lengths for string fields */
export const LIMITS = {
  MESSAGE_TEXT_MAX: 4096,
  FIRST_NAME_MAX: 64,
  LAST_NAME_MAX: 64,
  USERNAME_MAX: 32,
  USERNAME_MIN: 5,
  PHONE_MAX: 20,
  PHONE_MIN: 7,
  PEER_KEY_MAX: 64,
  MAX_MESSAGE_IDS_PER_REQUEST: 100,
  MAX_FORWARD_MESSAGES: 100,
  MAX_HISTORY_LIMIT: 100,
  MAX_DIALOGS_LIMIT: 100,
  SEARCH_QUERY_MAX: 256,
} as const;

/** Validate phone number format (digits, optional +) */
export function validatePhone(phone: string): string | undefined {
  if (!phone || phone.length < LIMITS.PHONE_MIN || phone.length > LIMITS.PHONE_MAX) {
    return 'PHONE_NUMBER_INVALID';
  }
  if (!/^\+?\d+$/.test(phone)) {
    return 'PHONE_NUMBER_INVALID';
  }
  return undefined;
}

/** Validate message text */
export function validateMessageText(text: string): string | undefined {
  if (typeof text !== 'string') {
    return 'MESSAGE_EMPTY';
  }
  if (text.length === 0) {
    return 'MESSAGE_EMPTY';
  }
  if (text.length > LIMITS.MESSAGE_TEXT_MAX) {
    return 'MESSAGE_TOO_LONG';
  }
  return undefined;
}

/** Validate a user name field */
export function validateName(name: string, field: 'FIRSTNAME' | 'LASTNAME'): string | undefined {
  if (typeof name !== 'string') {
    return `${field}_INVALID`;
  }
  const maxLen = field === 'FIRSTNAME' ? LIMITS.FIRST_NAME_MAX : LIMITS.LAST_NAME_MAX;
  if (name.length > maxLen) {
    return `${field}_INVALID`;
  }
  if (field === 'FIRSTNAME' && name.trim().length === 0) {
    return `${field}_INVALID`;
  }
  return undefined;
}

/** Validate username */
export function validateUsername(username: string): string | undefined {
  if (typeof username !== 'string') {
    return 'USERNAME_INVALID';
  }
  if (username.length > 0) {
    if (username.length < LIMITS.USERNAME_MIN || username.length > LIMITS.USERNAME_MAX) {
      return 'USERNAME_INVALID';
    }
    // Telegram usernames: a-z, 0-9, underscore; must start with a letter
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(username)) {
      return 'USERNAME_INVALID';
    }
  }
  return undefined;
}

/** Validate peer key format */
export function validatePeerKey(peerKey: string): string | undefined {
  if (!peerKey || peerKey.length > LIMITS.PEER_KEY_MAX) {
    return 'PEER_ID_INVALID';
  }
  // Must match user:NNNN or channel:NNNN or chat:NNNN
  if (!/^(user|channel|chat):\d+$/.test(peerKey)) {
    return 'PEER_ID_INVALID';
  }
  return undefined;
}

/** Validate message IDs array */
export function validateMessageIds(ids: number[]): string | undefined {
  if (!Array.isArray(ids) || ids.length === 0) {
    return 'MESSAGE_ID_INVALID';
  }
  if (ids.length > LIMITS.MAX_MESSAGE_IDS_PER_REQUEST) {
    return 'MESSAGE_ID_INVALID';
  }
  for (const id of ids) {
    if (typeof id !== 'number' || id <= 0 || !Number.isInteger(id)) {
      return 'MESSAGE_ID_INVALID';
    }
  }
  return undefined;
}

/** Validate auth code format (5-digit) */
export function validateAuthCode(code: string): string | undefined {
  if (!code || !/^\d{5}$/.test(code)) {
    return 'PHONE_CODE_INVALID';
  }
  return undefined;
}

/** Validate a limit parameter */
export function clampLimit(limit: number | undefined, max: number, defaultVal: number): number {
  if (typeof limit !== 'number' || limit <= 0) return defaultVal;
  return Math.min(limit, max);
}
