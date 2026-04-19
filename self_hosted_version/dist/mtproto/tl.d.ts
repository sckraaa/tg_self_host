export interface TLObject {
    readonly CONSTRUCTOR_ID: number;
    readonly className: string;
    getBytes(): Buffer;
}
export declare class TLReader {
    private buffer;
    offset: number;
    constructor(data: Buffer);
    readByte(): number;
    readInt(signed?: boolean): number;
    readLong(signed?: boolean): bigint;
    readBytes(length: number): Buffer;
    readString(): string;
    readVector<T>(): T[];
    remaining(): number;
    peekConstructorId(): number;
    getOffset(): number;
}
export declare class TLWriter {
    private buffer;
    private length;
    constructor();
    writeByte(value: number): void;
    writeInt(value: number, signed?: boolean): void;
    writeLong(value: bigint): void;
    writeBytes(data: Buffer): void;
    writeString(value: string): void;
    writeVector<T extends TLObject>(items: T[]): void;
    getBytes(): Buffer;
}
//# sourceMappingURL=tl.d.ts.map