import { createCipheriv, createDecipheriv, createHash, randomBytes, createPrivateKey, privateDecrypt, constants } from 'crypto';

export function rsaDecrypt(buffer: Buffer, privateKeyPem: string): Buffer {
  const key = createPrivateKey({ key: privateKeyPem, format: 'pem' });
  const decrypted = privateDecrypt(
    { key, padding: constants.RSA_NO_PADDING },
    buffer
  );
  return decrypted;
}

const SERVER_DH_PRIME = BigInt('0x' + 'c71caeb9c6b1c9048e6c522f70f13f73980d40238e3e21c14934d037563d930f48198a0aa7c14058229493d22530f4dbfa336f6e0ac925139543aed44cce7c3720fd51f69458705ac68cd4fe6b6b13abdc9746512969328454f18faf8c595f642477fe96bb2a941d5bcd1d4ac8cc49880708fa9b378e3c4f3a9060bee67cf9a4a4a695811051907e162753b56b0f6b410dba74d8a84b2a14b3144e0ef1284754fd17ed950d5965b4b9dd46582db1178d169c6bc465b0d6ff9ca3928fef5b9ae4e418fc15e83ebea0f87fa9ff5eed70050ded2849f47bf959d956850ce929851f0d8115f635b105ee2e4e15d04b2454bf6f4fadf034b10403119cd8e3b92fcc5b');

export function modExp(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) {
      result = (result * base) % mod;
    }
    exp = exp >> 1n;
    base = (base * base) % mod;
  }
  return result;
}

export function generateRandomBytes(length: number): Buffer {
  return randomBytes(length);
}

export function sha256Sync(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

export function sha1Sync(data: Buffer): Buffer {
  return createHash('sha1').update(data).digest();
}

export async function sha256(data: Buffer): Promise<Buffer> {
  return sha256Sync(data);
}

export async function sha1(data: Buffer): Promise<Buffer> {
  return sha1Sync(data);
}

export class IGE {
  private key: Buffer;
  private iv: Buffer;

  constructor(key: Buffer, iv: Buffer) {
    this.key = key;
    this.iv = iv;
  }

  encryptIge(data: Buffer): Buffer {
    if (data.length % 16 !== 0) throw new Error('IGE: data length must be multiple of 16');

    // Match @cryptography/aes convention: iv[16:32] = x_prev, iv[0:16] = y_prev
    let ivP = this.iv.slice(16, 32);  // x_prev
    let ivC = this.iv.slice(0, 16);   // y_prev

    const result = Buffer.alloc(data.length);

    for (let i = 0; i < data.length; i += 16) {
      const block = data.slice(i, i + 16);

      // XOR plaintext with y_prev
      const xored = Buffer.alloc(16);
      for (let j = 0; j < 16; j++) xored[j] = block[j] ^ ivC[j];

      // AES-ECB encrypt single block
      const cipher = createCipheriv('aes-256-ecb', this.key, null);
      cipher.setAutoPadding(false);
      const encrypted = cipher.update(xored);

      // XOR ciphertext with x_prev
      const out = Buffer.alloc(16);
      for (let j = 0; j < 16; j++) out[j] = encrypted[j] ^ ivP[j];

      out.copy(result, i);
      ivP = block;  // x_prev = plaintext block
      ivC = out;    // y_prev = ciphertext block
    }

    return result;
  }

  decryptIge(data: Buffer): Buffer {
    if (data.length % 16 !== 0) throw new Error('IGE: data length must be multiple of 16');

    // Match @cryptography/aes convention: iv[16:32] = y_prev (pre-AES XOR), iv[0:16] = x_prev (post-AES XOR)
    let ivP = this.iv.slice(16, 32);  // y_prev: XOR with ciphertext before AES decrypt
    let ivC = this.iv.slice(0, 16);   // x_prev: XOR with result after AES decrypt

    const result = Buffer.alloc(data.length);

    for (let i = 0; i < data.length; i += 16) {
      const block = data.slice(i, i + 16);

      // XOR ciphertext with x_prev
      const xored = Buffer.alloc(16);
      for (let j = 0; j < 16; j++) xored[j] = block[j] ^ ivP[j];

      // AES-ECB decrypt single block
      const decipher = createDecipheriv('aes-256-ecb', this.key, null);
      decipher.setAutoPadding(false);
      const decrypted = decipher.update(xored);

      // XOR plaintext with y_prev
      const out = Buffer.alloc(16);
      for (let j = 0; j < 16; j++) out[j] = decrypted[j] ^ ivC[j];

      out.copy(result, i);
      ivP = out;    // x_prev = plaintext block
      ivC = block;  // y_prev = ciphertext block
    }

    return result;
  }
}

export class CTR {
  private cipher: ReturnType<typeof createCipheriv>;

  constructor(key: Buffer, iv: Buffer) {
    // AES-256-CTR is a streaming cipher — one instance maintains counter state across calls
    this.cipher = createCipheriv('aes-256-ctr', key, iv);
  }

  encrypt(data: Buffer): Buffer {
    return this.cipher.update(data);
  }

  decrypt(data: Buffer): Buffer {
    return this.encrypt(data); // CTR encrypt === decrypt
  }
}

export function bufferXor(a: Buffer, b: Buffer): Buffer {
  const result = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) {
    result[i] = a[i] ^ b[i];
  }
  return result;
}

export function readBufferFromBigInt(value: bigint, length: number): Buffer {
  const hex = value.toString(16).padStart(length * 2, '0');
  return Buffer.from(hex, 'hex');
}

export function readBigIntFromBuffer(buffer: Buffer, littleEndian = true): bigint {
  if (littleEndian) {
    let result = 0n;
    for (let i = buffer.length - 1; i >= 0; i--) {
      result = (result << 8n) | BigInt(buffer[i]);
    }
    return result;
  }
  return BigInt('0x' + buffer.toString('hex'));
}
