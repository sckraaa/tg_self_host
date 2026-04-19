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

export const MTPROTO_ERROR_CODES = {
  INVALID_CLIENT_SECRET: -303,
  INVALID_SESSION: -303,
  SESSION_EXPIRED: -303,
  AUTH_KEY_INVALID: -404,
  USER_REGISTRATION_REQUIRED: -406,
} as const;
