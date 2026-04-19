export declare function rsaDecrypt(buffer: Buffer, privateKeyPem: string): Buffer;
export declare function modExp(base: bigint, exp: bigint, mod: bigint): bigint;
export declare function generateRandomBytes(length: number): Buffer;
export declare function sha256Sync(data: Buffer): Buffer;
export declare function sha1Sync(data: Buffer): Buffer;
export declare function sha256(data: Buffer): Promise<Buffer>;
export declare function sha1(data: Buffer): Promise<Buffer>;
export declare class IGE {
    private key;
    private iv;
    constructor(key: Buffer, iv: Buffer);
    encryptIge(data: Buffer): Buffer;
    decryptIge(data: Buffer): Buffer;
}
export declare class CTR {
    private cipher;
    constructor(key: Buffer, iv: Buffer);
    encrypt(data: Buffer): Buffer;
    decrypt(data: Buffer): Buffer;
}
export declare function bufferXor(a: Buffer, b: Buffer): Buffer;
export declare function readBufferFromBigInt(value: bigint, length: number): Buffer;
export declare function readBigIntFromBuffer(buffer: Buffer, littleEndian?: boolean): bigint;
//# sourceMappingURL=utils.d.ts.map