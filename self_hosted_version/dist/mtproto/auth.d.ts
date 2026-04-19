import { CTR } from '../crypto/utils.js';
export interface AuthState {
    nonce?: Buffer;
    serverNonce?: Buffer;
    newNonce?: Buffer;
    p?: Buffer;
    q?: Buffer;
    a?: Buffer;
    gA?: Buffer;
    authKey?: Buffer;
    keyId?: bigint;
    serverPublicKey?: {
        n: bigint;
        e: number;
    };
}
export declare function generateObfuscatedHeader(): {
    header: Buffer;
    encryptor: CTR;
    decryptor: CTR;
};
export declare class AuthHandler {
    private authState;
    private authKeys;
    private authKeysByKeyId;
    getOrCreateAuthState(sessionId: string): AuthState;
    clearAuthState(sessionId: string): void;
    setAuthKey(sessionId: string, key: Buffer): void;
    getAuthKey(sessionId: string): Buffer | undefined;
    getAuthKeyByKeyId(authKeyId: bigint): Buffer | undefined;
    bindAuthKeyToSession(sessionId: string, authKeyId: bigint): void;
    private computeAuthKeyId;
    getAllAuthKeys(): Array<{
        keyIdHex: string;
        authKey: Buffer;
    }>;
    loadAuthKey(keyIdHex: string, authKey: Buffer): void;
    removeAuthKey(authKey: Buffer): void;
    processReqPqMultiSync(buffer: Buffer, sessionId: string): Buffer;
    processReqDHParamsSync(buffer: Buffer, sessionId: string): Buffer;
    processSetClientDHParamsSync(buffer: Buffer, sessionId: string): Buffer;
}
//# sourceMappingURL=auth.d.ts.map