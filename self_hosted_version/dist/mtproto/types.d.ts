export interface MTProtoMessage {
    msg_id: bigint;
    seqno: number;
    data: Buffer;
}
export interface MTProtoResponse {
    msgId: bigint;
    seqNo: number;
    data: Buffer;
}
export interface AuthKeyData {
    keyId: string;
    key: Buffer;
    sessionId: string;
}
export interface ServerConfig {
    apiId: number;
    apiHash: string;
    dcId: number;
    host: string;
    port: number;
}
export declare const MTPROTO_ERROR_CODES: {
    readonly INVALID_CLIENT_SECRET: -303;
    readonly INVALID_SESSION: -303;
    readonly SESSION_EXPIRED: -303;
    readonly AUTH_KEY_INVALID: -404;
    readonly USER_REGISTRATION_REQUIRED: -406;
};
//# sourceMappingURL=types.d.ts.map