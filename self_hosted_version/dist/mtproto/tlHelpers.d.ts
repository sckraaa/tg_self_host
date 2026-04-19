import { BinaryReader, BinaryWriter } from './codec.js';
export declare function writeTlString(w: BinaryWriter, str: string): void;
export declare function writeTlBytes(w: BinaryWriter, data: Buffer): void;
export declare function readTlBytesRaw(reader: BinaryReader): Buffer;
export declare function readTlString(reader: BinaryReader): string;
export declare function skipTlString(data: Buffer, offset: number): number;
export declare function skipJsonValue(data: Buffer, offset: number): number;
export declare function skipTlStringByReader(reader: BinaryReader): void;
export declare function skipInputPeer(reader: BinaryReader): void;
export declare function parseInputReplyTo(reader: BinaryReader): {
    replyToMsgId: number;
    quoteText?: string;
    quoteOffset?: number;
} | undefined;
export declare function skipTlVector(reader: BinaryReader): void;
export declare function skipTlObject(reader: BinaryReader): void;
export declare function writeEmptyVectorToWriter(w: BinaryWriter): void;
export declare function writeBufferVector(w: BinaryWriter, items: Buffer[]): void;
export declare function writeIntVector(w: BinaryWriter, values: number[]): void;
export declare function writeEmptyJsonObject(w: BinaryWriter): void;
export interface InitConnectionInfo {
    deviceModel: string;
    systemVersion: string;
    appVersion: string;
    innerQuery: Buffer;
}
export declare function parseInitConnection(data: Buffer): InitConnectionInfo | null;
export declare function skipInitConnection(data: Buffer): Buffer | null;
//# sourceMappingURL=tlHelpers.d.ts.map