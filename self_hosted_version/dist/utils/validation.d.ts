/**
 * Input validation for RPC requests. Returns error string if invalid, undefined if ok.
 */
/** Max lengths for string fields */
export declare const LIMITS: {
    readonly MESSAGE_TEXT_MAX: 4096;
    readonly FIRST_NAME_MAX: 64;
    readonly LAST_NAME_MAX: 64;
    readonly USERNAME_MAX: 32;
    readonly USERNAME_MIN: 5;
    readonly PHONE_MAX: 20;
    readonly PHONE_MIN: 7;
    readonly PEER_KEY_MAX: 64;
    readonly MAX_MESSAGE_IDS_PER_REQUEST: 100;
    readonly MAX_FORWARD_MESSAGES: 100;
    readonly MAX_HISTORY_LIMIT: 100;
    readonly MAX_DIALOGS_LIMIT: 100;
    readonly SEARCH_QUERY_MAX: 256;
};
/** Validate phone number format (digits, optional +) */
export declare function validatePhone(phone: string): string | undefined;
/** Validate message text */
export declare function validateMessageText(text: string): string | undefined;
/** Validate a user name field */
export declare function validateName(name: string, field: 'FIRSTNAME' | 'LASTNAME'): string | undefined;
/** Validate username */
export declare function validateUsername(username: string): string | undefined;
/** Validate peer key format */
export declare function validatePeerKey(peerKey: string): string | undefined;
/** Validate message IDs array */
export declare function validateMessageIds(ids: number[]): string | undefined;
/** Validate auth code format (5-digit) */
export declare function validateAuthCode(code: string): string | undefined;
/** Validate a limit parameter */
export declare function clampLimit(limit: number | undefined, max: number, defaultVal: number): number;
//# sourceMappingURL=validation.d.ts.map