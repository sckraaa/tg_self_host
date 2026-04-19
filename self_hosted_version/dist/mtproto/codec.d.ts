export declare function encodePacket(data: Buffer): Buffer;
export declare function decodePacket(buffer: Buffer): Buffer;
export declare function generateMessageId(): bigint;
export declare function sha256Sync(data: Buffer): Promise<Buffer>;
export declare class BinaryReader {
    private buffer;
    offset: number;
    constructor(data: Buffer);
    readByte(): number;
    readInt(): number;
    readLong(signed?: boolean): bigint;
    readBytes(length: number): Buffer;
    readString(): string;
    remaining(): number;
    peekConstructorId(): number;
}
export declare class BinaryWriter {
    private buffer;
    private length;
    constructor();
    writeByte(value: number): void;
    writeInt(value: number): void;
    writeLong(value: bigint): void;
    writeBytes(data: Buffer): void;
    writeString(value: string): void;
    getBytes(): Buffer;
}
//# sourceMappingURL=codec.d.ts.map