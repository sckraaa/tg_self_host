export class TLReader {
    buffer;
    offset = 0;
    constructor(data) {
        this.buffer = data;
    }
    readByte() {
        return this.buffer[this.offset++];
    }
    readInt(signed = true) {
        const result = signed
            ? this.buffer.readInt32LE(this.offset)
            : this.buffer.readUInt32LE(this.offset);
        this.offset += 4;
        return result;
    }
    readLong(signed = true) {
        const result = signed
            ? this.buffer.readBigInt64LE(this.offset)
            : this.buffer.readBigInt64LE(this.offset);
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
        const strBuffer = this.readBytes(len);
        return strBuffer.toString('utf-8');
    }
    readVector() {
        const size = this.readInt();
        return size;
    }
    remaining() {
        return this.buffer.length - this.offset;
    }
    peekConstructorId() {
        return this.buffer.readUInt32LE(this.offset);
    }
    getOffset() {
        return this.offset;
    }
}
export class TLWriter {
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
    writeInt(value, signed = true) {
        const buf = Buffer.alloc(4);
        if (signed) {
            buf.writeInt32LE(value, 0);
        }
        else {
            buf.writeUInt32LE(value, 0);
        }
        this.buffer.push(buf);
        this.length += 4;
    }
    writeLong(value) {
        const buf = Buffer.alloc(8);
        buf.writeBigInt64LE(value, 0);
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
        this.writeBytes(strBuffer);
    }
    writeVector(items) {
        this.writeInt(items.length);
        for (const item of items) {
            this.writeBytes(item.getBytes());
        }
    }
    getBytes() {
        return Buffer.concat(this.buffer);
    }
}
//# sourceMappingURL=tl.js.map