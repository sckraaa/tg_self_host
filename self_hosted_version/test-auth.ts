import WebSocket from 'ws';
import crypto from 'crypto';

function generateRandomBytes(length: number): Buffer {
  return crypto.randomBytes(length);
}

function writePacket(data: Buffer): Buffer {
  const length = data.length >> 2;
  if (length < 127) {
    const header = Buffer.alloc(1);
    header.writeUInt8(length, 0);
    return Buffer.concat([header, data]);
  } else {
    const header = Buffer.alloc(4);
    header.writeUInt8(0x7f, 0);
    header.writeUInt32LE(length, 1);
    return Buffer.concat([header, data]);
  }
}

function buildReqPqMulti(): Buffer {
  const nonce = generateRandomBytes(16);
  const writer = {
    buffer: [] as Buffer[],
    writeInt(value: number) {
      const buf = Buffer.alloc(4);
      buf.writeUInt32LE(value >>> 0, 0);
      this.buffer.push(buf);
    },
    writeBytes(data: Buffer) {
      this.buffer.push(data);
    },
    getBytes() {
      return Buffer.concat(this.buffer);
    }
  };
  
  writer.writeInt(0x83c95e1e); // PQOuterData constructor
  writer.writeBytes(nonce);
  
  return writer.getBytes();
}

const ws = new WebSocket('ws://localhost:8080');

let step = 0;

ws.on('open', () => {
  console.log('[1] Connected to MTProto server');
  
  // Step 1: Send 0xef to initiate abridged mode
  ws.send(Buffer.from([0xef]));
});

ws.on('message', (data: Buffer) => {
  console.log(`[${step + 2}] Received message, length: ${data.length}`);
  console.log('Hex:', data.toString('hex').slice(0, 80));
  
  if (step === 0) {
    // After abridged handshake, send ReqPqMulti
    console.log('[3] Sending ReqPqMulti...');
    const reqPq = buildReqPqMulti();
    console.log('ReqPq hex:', reqPq.toString('hex').slice(0, 40) + '...');
    ws.send(writePacket(reqPq));
    step++;
  } else if (step === 1) {
    console.log('[4] Received ResPQ response');
    
    // Try to parse ResPQ
    const reader = {
      offset: 0,
      buffer: data,
      readIntLE(): number {
        const v = this.buffer.readInt32LE(this.offset);
        this.offset += 4;
        return v;
      },
      readBytes(len: number): Buffer {
        const b = this.buffer.slice(this.offset, this.offset + len);
        this.offset += len;
        return b;
      }
    };
    
    const constructorId = reader.readIntLE();
    console.log('Constructor ID: 0x' + constructorId.toString(16));
    
    if (constructorId === 0x05162463) {
      console.log('ResPQ parsed successfully!');
      const nonce = reader.readBytes(16);
      const serverNonce = reader.readBytes(32);
      console.log('Server nonce:', serverNonce.toString('hex').slice(0, 16) + '...');
    } else {
      console.log('First 4 bytes:', data.slice(0, 4).toString('hex'));
    }
    
    ws.close();
    process.exit(0);
  }
});

ws.on('close', () => {
  console.log('Disconnected');
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

setTimeout(() => {
  console.log('Test timeout');
  ws.close();
  process.exit(0);
}, 8000);
