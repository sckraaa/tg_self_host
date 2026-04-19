import { sha256 } from '../crypto/utils.js';
export function encodePacket(data) {
    const length = data.length >> 2;
    let header;
    if (length < 127) {
        header = Buffer.alloc(1);
        header.writeUInt8(length, 0);
    }
    else {
        header = Buffer.alloc(4);
        header.writeUInt8(0x7f, 0);
        header.writeUInt32LE(length, 1);
    }
    return Buffer.concat([header, data]);
}
export function decodePacket(buffer) {
    let offset = 0;
    let length;
    if (buffer[0] === 0x7f) {
        length = buffer.readUInt32LE(1);
        offset = 4;
    }
    else {
        length = buffer[0];
        offset = 1;
    }
    return buffer.slice(offset, offset + (length << 2));
}
export function generateMessageId() {
    const now = Date.now() / 1000;
    const seconds = Math.floor(now);
    const nanoseconds = Math.floor((now - seconds) * 1e9);
    let msgId = (BigInt(seconds) << 32n) | (BigInt(nanoseconds) << 2n);
    return msgId;
}
export async function sha256Sync(data) {
    return sha256(data);
}
export class BinaryReader {
    buffer;
    offset = 0;
    constructor(data) {
        this.buffer = data;
    }
    readByte() {
        return this.buffer[this.offset++];
    }
    readInt() {
        const result = this.buffer.readInt32LE(this.offset);
        this.offset += 4;
        return result;
    }
    readLong(signed = true) {
        let result;
        if (signed) {
            result = this.buffer.readBigInt64LE(this.offset);
        }
        else {
            result = this.buffer.readBigUInt64LE(this.offset);
        }
        this.offset += 8;
        return result;
    }
    readBytes(length) {
        const result = this.buffer.slice(this.offset, this.offset + length);
        this.offset += length;
        return result;
    }
    readString() {
        const len = this.readByte();
        return this.readBytes(len).toString('utf-8');
    }
    remaining() {
        return this.buffer.length - this.offset;
    }
    peekConstructorId() {
        return this.buffer.readUInt32LE(this.offset);
    }
}
export class BinaryWriter {
    buffer;
    length = 0;
    constructor() {
        this.buffer = [];
    }
    writeByte(value) {
        const buf = Buffer.alloc(1);
        buf.writeUInt8(value, 0);
        this.buffer.push(buf);
        this.length += 1;
    }
    writeInt(value) {
        const buf = Buffer.alloc(4);
        buf.writeUInt32LE(value >>> 0, 0);
        this.buffer.push(buf);
        this.length += 4;
    }
    writeLong(value) {
        const buf = Buffer.alloc(8);
        // TL long is just 8 bytes; handle unsigned values >= 2^63
        if (value < 0n) {
            buf.writeBigInt64LE(value, 0);
        }
        else {
            buf.writeBigUInt64LE(value, 0);
        }
        this.buffer.push(buf);
        this.length += 8;
    }
    writeBytes(data) {
        this.buffer.push(data);
        this.length += data.length;
    }
    writeString(value) {
        const strBuffer = Buffer.from(value, 'utf-8');
        this.writeByte(strBuffer.length);
        this.buffer.push(strBuffer);
        this.length += strBuffer.length;
    }
    getBytes() {
        return Buffer.concat(this.buffer);
    }
}
//# sourceMappingURL=codec.js.map