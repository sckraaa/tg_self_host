import * as net from 'net';
import { createCipheriv, randomBytes, createHash } from 'crypto';

const HOST = process.env.HOST || '193.233.89.181';
const PORT = parseInt(process.env.PORT || '8443');

class CTR {
  private cipher: ReturnType<typeof createCipheriv>;
  constructor(key: Buffer, iv: Buffer) {
    this.cipher = createCipheriv('aes-256-ctr', key, iv);
  }
  encrypt(data: Buffer): Buffer {
    return this.cipher.update(data);
  }
  decrypt(data: Buffer): Buffer {
    return this.encrypt(data);
  }
}

function buildObfuscatedHeader(): { header: Buffer; encryptor: CTR; decryptor: CTR } {
  // Generate 64 random bytes, ensuring constraints
  let controlBytes: Buffer;
  while (true) {
    controlBytes = randomBytes(64);
    const first4 = controlBytes.readUInt32LE(0);
    // Avoid forbidden patterns
    if (first4 === 0x44414548 || first4 === 0x54534f50 || first4 === 0x20544547 ||
        first4 === 0x4954504f || first4 === 0xdddddddd || first4 === 0xeeeeeeee ||
        first4 === 0x16030102 || controlBytes[0] === 0xef) {
      continue;
    }
    break;
  }

  // Set abridged tag at 56-59
  controlBytes.writeUInt32LE(0xefefefef, 56);
  // DC tag at 60-61 (DC 2)
  controlBytes.writeInt16LE(2, 60);

  // Client encrypt key/IV
  const outKey = Buffer.from(controlBytes.subarray(8, 40));
  const outIv = Buffer.from(controlBytes.subarray(40, 56));

  // Server encrypt key/IV (reversed)
  const reversed = Buffer.alloc(64);
  for (let i = 0; i < 64; i++) reversed[i] = controlBytes[63 - i];
  const inKey = Buffer.from(reversed.subarray(8, 40));
  const inIv = Buffer.from(reversed.subarray(40, 56));

  const outCtr = new CTR(outKey, outIv);
  const inCtr = new CTR(inKey, inIv);

  // Encrypt the full 64 bytes to get encrypted version
  const encrypted = outCtr.encrypt(Buffer.from(controlBytes));

  // Build header: first 56 plaintext + last 8 encrypted
  const header = Buffer.alloc(64);
  controlBytes.copy(header, 0, 0, 56);
  encrypted.copy(header, 56, 56, 64);

  return { header, encryptor: outCtr, decryptor: inCtr };
}

function buildReqPqMulti(encryptor: CTR): Buffer {
  // Build req_pq_multi TL
  const nonce = randomBytes(16);
  const payload = Buffer.alloc(20);
  payload.writeUInt32LE(0xbe7e8ef1, 0); // req_pq_multi constructor
  nonce.copy(payload, 4);

  // Wrap in unencrypted MTProto envelope
  const authKeyId = Buffer.alloc(8); // 0
  const msgId = Buffer.alloc(8);
  const now = BigInt(Date.now());
  const seconds = now / 1000n;
  const nanos = (now % 1000n) * 1000000n;
  msgId.writeBigInt64LE((seconds << 32n) | (nanos << 2n), 0);
  const msgLen = Buffer.alloc(4);
  msgLen.writeInt32LE(payload.length, 0);

  const envelope = Buffer.concat([authKeyId, msgId, msgLen, payload]);

  // Abridged frame
  const quarterLen = envelope.length >> 2;
  let frame: Buffer;
  if (quarterLen < 127) {
    frame = Buffer.concat([Buffer.from([quarterLen]), envelope]);
  } else {
    const hdr = Buffer.alloc(4);
    hdr[0] = 0x7f;
    hdr[1] = quarterLen & 0xff;
    hdr[2] = (quarterLen >> 8) & 0xff;
    hdr[3] = (quarterLen >> 16) & 0xff;
    frame = Buffer.concat([hdr, envelope]);
  }

  console.log(`req_pq_multi frame: ${frame.length} bytes, nonce: ${nonce.toString('hex')}`);
  console.log(`  quarterLen: ${quarterLen}, envelope: ${envelope.length} bytes`);

  // Encrypt with CTR
  return encryptor.encrypt(frame);
}

async function main() {
  const { header, encryptor, decryptor } = buildObfuscatedHeader();

  console.log(`Connecting to ${HOST}:${PORT}...`);
  const socket = net.createConnection({ host: HOST, port: PORT }, () => {
    console.log('Connected!');

    // Send header + first message
    const reqPqEncrypted = buildReqPqMulti(encryptor);
    const fullData = Buffer.concat([header, reqPqEncrypted]);
    console.log(`Sending ${fullData.length} bytes (64 header + ${reqPqEncrypted.length} encrypted)`);

    socket.write(fullData, (err) => {
      if (err) console.error('Write error:', err);
      else console.log('Write callback: success');
    });
  });

  socket.on('data', (data: Buffer) => {
    console.log(`\nReceived ${data.length} bytes: ${data.toString('hex')}`);

    // Decrypt with incoming CTR
    const decrypted = decryptor.decrypt(data);
    console.log(`Decrypted ${decrypted.length} bytes: ${decrypted.toString('hex')}`);

    // Parse abridged frame
    const quarterLen = decrypted[0];
    console.log(`  Abridged quarter length: ${quarterLen} (body = ${quarterLen * 4} bytes)`);

    if (decrypted.length >= 1 + quarterLen * 4) {
      const body = decrypted.subarray(1, 1 + quarterLen * 4);
      console.log(`  Body: ${body.toString('hex')}`);

      // Parse MTProto envelope
      const authKeyId = body.readBigInt64LE(0);
      const msgIdVal = body.readBigInt64LE(8);
      const msgLength = body.readInt32LE(16);
      console.log(`  auth_key_id: ${authKeyId}`);
      console.log(`  msg_id: ${msgIdVal}`);
      console.log(`  msg_length: ${msgLength}`);

      const content = body.subarray(20);
      const constructor = content.readUInt32LE(0);
      console.log(`  constructor: 0x${constructor.toString(16)}`);

      if (constructor === 0x05162463) {
        console.log('  => res_pq received!');
        const nonce = content.subarray(4, 20);
        const serverNonce = content.subarray(20, 36);
        console.log(`  nonce: ${nonce.toString('hex')}`);
        console.log(`  server_nonce: ${serverNonce.toString('hex')}`);

        // Parse PQ (TL bytes)
        const pqLenByte = content[36];
        const pq = content.subarray(37, 37 + pqLenByte);
        console.log(`  pq: ${pq.toString('hex')} (len=${pqLenByte})`);

        // Parse fingerprints vector
        const fpOffset = 37 + pqLenByte + (4 - ((1 + pqLenByte) % 4)) % 4;
        const vectorCtor = content.readUInt32LE(fpOffset);
        const fpCount = content.readInt32LE(fpOffset + 4);
        console.log(`  vector constructor: 0x${vectorCtor.toString(16)}`);
        console.log(`  fingerprint count: ${fpCount}`);

        for (let i = 0; i < fpCount; i++) {
          const fp = content.readBigInt64LE(fpOffset + 8 + i * 8);
          console.log(`  fingerprint[${i}]: ${fp} (0x${fp.toString(16)})`);
        }
      }
    }

    // Close after receiving response
    setTimeout(() => {
      socket.destroy();
      process.exit(0);
    }, 1000);
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err);
  });

  socket.on('close', () => {
    console.log('Socket closed');
  });

  socket.on('timeout', () => {
    console.log('Socket timeout');
  });

  socket.setTimeout(10000);
}

main().catch(console.error);
