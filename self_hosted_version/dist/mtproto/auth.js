import { generateRandomBytes, sha256Sync, sha1Sync, IGE, CTR, modExp, readBigIntFromBuffer, readBufferFromBigInt, rsaDecrypt } from '../crypto/utils.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const RSA_PRIVATE_KEY = process.env.RSA_PRIVATE_KEY || readFileSync(join(__dirname, '../../rsa_private.pem'), 'utf-8');
const RSA_PUBLIC_KEY_N = BigInt('0x' + 'b9c491464de4a766c1e415d3ba806bc564c29b575f74b8edcdcd1674c806e3690318f6bb32b9fd936b19419cf93d280a40c4543763424faf65f2732331b7b2734c29cb374fede4b891c556d23a03634d8b99d9754fae807aca2c0aa49cb6677ecaf5d8d89d9782711b072aed417a7b4cfae204778cc60727e6e1e7db01db013900a780ae9eca4d19f6426cc2104df335a98300c01d4eeb1df57740b195a300c16c907333b00d113cc54f68cc5007dfe7b9747f85d30b09574761bf5d03c0ce4c70f2ddeaf00dffcbc4d8b76d959a3c7d9eeae41fe4f06fd91d51648415b0594b1ae9c8e3a7360a92ad6e23fe9c24a4b70a93dbd62b6ed9a839886be892948bb9');
const RSA_PUBLIC_KEY_E = 65537;
const RSA_FINGERPRINT = BigInt('-4164099621493681641');
const DH_PRIME = BigInt('0x' + 'c71caeb9c6b1c9048e6c522f70f13f73980d40238e3e21c14934d037563d930f48198a0aa7c14058229493d22530f4dbfa336f6e0ac925139543aed44cce7c3720fd51f69458705ac68cd4fe6b6b13abdc9746512969328454f18faf8c595f642477fe96bb2a941d5bcd1d4ac8cc49880708fa9b378e3c4f3a9060bee67cf9a4a4a695811051907e162753b56b0f6b410dba74d8a84b2a14b3144e0ef1284754fd17ed950d5965b4b9dd46582db1178d169c6bc465b0d6ff9ca3928fef5b9ae4e418fc15e83ebea0f87fa9ff5eed70050ded2849f47bf959d956850ce929851f0d8115f635b105ee2e4e15d04b2454bf6f4fadf034b10403119cd8e3b92fcc5b');
const G = 3n;
function toTlBytes(data) {
    const len = data.length;
    let header;
    if (len <= 253) {
        header = Buffer.alloc(1);
        header[0] = len;
    }
    else {
        header = Buffer.alloc(4);
        header[0] = 254;
        header[1] = len & 0xff;
        header[2] = (len >> 8) & 0xff;
        header[3] = (len >> 16) & 0xff;
    }
    const totalLen = header.length + len;
    const paddingLen = totalLen % 4 === 0 ? 0 : 4 - (totalLen % 4);
    return Buffer.concat([header, data, Buffer.alloc(paddingLen)]);
}
function readTlBytes(reader) {
    const lenByte = reader.readByte();
    let len;
    if (lenByte <= 253) {
        len = lenByte;
    }
    else {
        len = reader.readByte() | (reader.readByte() << 8) | (reader.readByte() << 16);
    }
    const totalLen = len + (len % 4 === 0 ? 0 : 4 - (len % 4));
    const padding = totalLen - len;
    const data = reader.readBytes(len);
    if (padding > 0)
        reader.readBytes(padding);
    return data;
}
const SERVER_RSA_KEYS = [
    {
        fingerprint: RSA_FINGERPRINT,
        n: RSA_PUBLIC_KEY_N,
        e: RSA_PUBLIC_KEY_E,
    },
];
function getKeyByFingerprint(fingerprint) {
    return SERVER_RSA_KEYS.find(k => k.fingerprint === fingerprint);
}
const OBFUSCATED_KEYWORDS = [
    Buffer.from('50567247', 'hex'),
    Buffer.from('474554', 'hex'),
    Buffer.from('504f5354', 'hex'),
    Buffer.from('eeeeeeee', 'hex'),
];
export function generateObfuscatedHeader() {
    let random;
    while (true) {
        const randBytes = generateRandomBytes(64);
        random = Array.from(randBytes);
        if (random[0] !== 0xef) {
            let allZero = true;
            for (let i = 4; i < 8; i++) {
                if (random[i] !== 0) {
                    allZero = false;
                    break;
                }
            }
            if (!allZero) {
                let ok = true;
                for (const key of OBFUSCATED_KEYWORDS) {
                    if (key.equals(Buffer.from(random.slice(0, 4)))) {
                        ok = false;
                        break;
                    }
                }
                if (ok)
                    break;
            }
        }
    }
    const randomReversed = Buffer.from(random.slice(8, 56)).reverse();
    const encryptKey = Buffer.from(random.slice(8, 40));
    const encryptIv = Buffer.from(random.slice(40, 56));
    const decryptKey = Buffer.from(randomReversed.slice(0, 32));
    const decryptIv = Buffer.from(randomReversed.slice(32, 48));
    const encryptor = new CTR(encryptKey, encryptIv);
    const decryptor = new CTR(decryptKey, decryptIv);
    const tag = Buffer.from('efefefef', 'hex');
    const header = Buffer.concat([
        Buffer.from(random.slice(0, 56)),
        tag,
        Buffer.from(random.slice(60)),
    ]);
    return { header, encryptor, decryptor };
}
function generateKeyDataFromNonce(serverNonce, newNonce) {
    const hash1 = sha1Sync(Buffer.concat([newNonce, serverNonce]));
    const hash2 = sha1Sync(Buffer.concat([serverNonce, newNonce]));
    const hash3 = sha1Sync(Buffer.concat([newNonce, newNonce]));
    const key = Buffer.concat([hash1, hash2.slice(0, 12)]);
    const iv = Buffer.concat([hash2.slice(12, 20), hash3, newNonce.slice(0, 4)]);
    return { key, iv };
}
function bufferXor(a, b) {
    const result = Buffer.alloc(Math.max(a.length, b.length));
    for (let i = 0; i < result.length; i++) {
        result[i] = (a[i] || 0) ^ (b[i] || 0);
    }
    return result;
}
function padToBlock(data, blockSize = 16) {
    const padLen = blockSize - (data.length % blockSize);
    return Buffer.concat([data, generateRandomBytes(padLen)]);
}
export class AuthHandler {
    authState = new Map();
    authKeys = new Map();
    authKeysByKeyId = new Map();
    getOrCreateAuthState(sessionId) {
        if (!this.authState.has(sessionId)) {
            this.authState.set(sessionId, {});
        }
        return this.authState.get(sessionId);
    }
    clearAuthState(sessionId) {
        this.authState.delete(sessionId);
    }
    setAuthKey(sessionId, key) {
        this.authKeys.set(sessionId, key);
        const keyIdHex = this.computeAuthKeyId(key);
        this.authKeysByKeyId.set(keyIdHex, key);
        console.log(`[AUTH] Stored auth key for session ${sessionId}, keyId=${keyIdHex}`);
    }
    getAuthKey(sessionId) {
        return this.authKeys.get(sessionId);
    }
    getAuthKeyByKeyId(authKeyId) {
        const keyIdBuf = Buffer.alloc(8);
        keyIdBuf.writeBigInt64LE(authKeyId, 0);
        const keyIdHex = keyIdBuf.toString('hex');
        return this.authKeysByKeyId.get(keyIdHex);
    }
    bindAuthKeyToSession(sessionId, authKeyId) {
        const key = this.getAuthKeyByKeyId(authKeyId);
        if (key) {
            this.authKeys.set(sessionId, key);
        }
    }
    computeAuthKeyId(key) {
        return sha1Sync(key).slice(12, 20).toString('hex');
    }
    getAllAuthKeys() {
        return Array.from(this.authKeysByKeyId.entries()).map(([keyIdHex, authKey]) => ({
            keyIdHex,
            authKey,
        }));
    }
    loadAuthKey(keyIdHex, authKey) {
        this.authKeysByKeyId.set(keyIdHex, authKey);
    }
    removeAuthKey(authKey) {
        const keyIdHex = this.computeAuthKeyId(authKey);
        this.authKeysByKeyId.delete(keyIdHex);
        // Also remove from session-keyed map
        for (const [sessionId, key] of this.authKeys.entries()) {
            if (key.equals(authKey)) {
                this.authKeys.delete(sessionId);
            }
        }
        console.log(`[AUTH] Removed auth key keyId=${keyIdHex}`);
    }
    processReqPqMultiSync(buffer, sessionId) {
        const reader = new BR(buffer);
        const constructorId = reader.readInt(false);
        if (constructorId !== 0xbe7e8ef1 && constructorId !== 0x60469778) {
            throw new Error(`Invalid PQ outer data constructor: 0x${constructorId.toString(16)}`);
        }
        const nonce = reader.readBytes(16);
        const state = this.getOrCreateAuthState(sessionId);
        state.nonce = nonce;
        state.serverNonce = generateRandomBytes(16);
        const resPQ = new BW();
        resPQ.writeInt(0x05162463);
        resPQ.writeBytes(nonce);
        resPQ.writeBytes(state.serverNonce);
        // pq must be a product of two primes that the client can factorize
        // Both p and q must be actual primes for MTFactorize (Pollard rho) to work
        const p = 1229539387n;
        const q = 1402015859n;
        const pqValue = p * q;
        const pBuf = Buffer.alloc(4);
        pBuf.writeUInt32BE(Number(p), 0);
        const qBuf = Buffer.alloc(4);
        qBuf.writeUInt32BE(Number(q), 0);
        state.p = pBuf;
        state.q = qBuf;
        // Write pq as big-endian 8-byte buffer
        const pq = Buffer.alloc(8);
        pq.writeBigUInt64BE(pqValue, 0);
        resPQ.writeBytes(toTlBytes(pq));
        // serverPublicKeyFingerprints is Vector<long> — needs vector constructor prefix
        resPQ.writeInt(0x1cb5c415); // vector constructor
        resPQ.writeInt(1); // count
        resPQ.writeLong(SERVER_RSA_KEYS[0].fingerprint);
        return resPQ.getBytes();
    }
    processReqDHParamsSync(buffer, sessionId) {
        const reader = new BR(buffer);
        const constructorId = reader.readInt(false);
        if (constructorId !== 0xd712e4be)
            throw new Error("Invalid req DH params constructor");
        const nonce = reader.readBytes(16);
        const serverNonce = reader.readBytes(16);
        const p = reader.readTlBytes();
        const q = reader.readTlBytes();
        const fingerprint = reader.readLong(false);
        const encryptedData = reader.readTlBytes();
        const rsaDecrypted = rsaDecrypt(encryptedData, RSA_PRIVATE_KEY);
        console.log(`[DEBUG] RSA decrypted length: ${rsaDecrypted.length}`);
        const tempKeyXor = rsaDecrypted.slice(0, 32);
        const aesEncrypted = rsaDecrypted.slice(32);
        console.log(`[DEBUG] tempKeyXor: ${tempKeyXor.slice(0, 8).toString('hex')}... aesEncrypted length: ${aesEncrypted.length}`);
        const tempKey = bufferXor(tempKeyXor, sha256Sync(aesEncrypted));
        const decrypted = new IGE(tempKey, Buffer.alloc(32)).decryptIge(aesEncrypted);
        console.log(`[DEBUG] IGE decrypted length: ${decrypted.length}, first 16: ${decrypted.slice(0, 16).toString('hex')}`);
        const innerDataReversed = decrypted.slice(0, 192);
        const pqInnerData = Buffer.from(innerDataReversed).reverse();
        console.log(`[DEBUG] pqInnerData first 20: ${pqInnerData.slice(0, 20).toString('hex')}`);
        const innerReader = new BR(pqInnerData);
        const pqInnerConstructor = innerReader.readInt(false);
        console.log(`[DEBUG] PQInnerData constructor: 0x${pqInnerConstructor.toString(16)}`);
        // PQInnerData = 0x83c95aec, PQInnerDataDc = 0xa9f55f95
        const validPqConstructors = [0x83c95aec, 0xa9f55f95, 0x3c6a84d4, 0x56fddf88];
        if (!validPqConstructors.includes(pqInnerConstructor)) {
            throw new Error(`Invalid PQInnerData constructor: 0x${pqInnerConstructor.toString(16)}`);
        }
        innerReader.readTlBytes(); // pq
        innerReader.readTlBytes(); // p
        innerReader.readTlBytes(); // q
        const innerNonce = innerReader.readBytes(16);
        const innerServerNonce = innerReader.readBytes(16);
        const clientNewNonce = innerReader.readBytes(32);
        console.log(`[DEBUG] newNonce: ${clientNewNonce.toString('hex')}`);
        console.log(`[DEBUG] serverNonce from req: ${serverNonce.toString('hex')}`);
        const state = this.getOrCreateAuthState(sessionId);
        state.nonce = nonce;
        state.serverNonce = serverNonce;
        state.newNonce = clientNewNonce;
        const a = generateRandomBytes(256);
        state.a = a;
        const gA = modExp(G, readBigIntFromBuffer(a, false), DH_PRIME);
        state.gA = readBufferFromBigInt(gA, 256);
        const innerData = new BW();
        innerData.writeInt(0xb5890dba); // server_DH_inner_data constructor
        innerData.writeBytes(nonce);
        innerData.writeBytes(serverNonce);
        innerData.writeInt(3);
        innerData.writeBytes(toTlBytes(readBufferFromBigInt(DH_PRIME, 256)));
        innerData.writeBytes(toTlBytes(state.gA));
        innerData.writeInt(Math.floor(Date.now() / 1000));
        const innerBytes = innerData.getBytes();
        const dataWithHash = Buffer.concat([sha1Sync(innerBytes), innerBytes]);
        const { key: tmpKey, iv: tmpIv } = generateKeyDataFromNonce(serverNonce, state.newNonce);
        console.log(`[DEBUG] tmpKey: ${tmpKey.toString('hex')}`);
        console.log(`[DEBUG] tmpIv: ${tmpIv.toString('hex')}`);
        console.log(`[DEBUG] dataWithHash length: ${dataWithHash.length}, padded: ${padToBlock(dataWithHash, 16).length}`);
        const encryptedAnswer = new IGE(tmpKey, tmpIv).encryptIge(padToBlock(dataWithHash, 16));
        const resOk = new BW();
        resOk.writeInt(0xd0e8075c); // server_DH_params_ok
        resOk.writeBytes(nonce);
        resOk.writeBytes(serverNonce);
        resOk.writeBytes(toTlBytes(encryptedAnswer));
        return resOk.getBytes();
    }
    processSetClientDHParamsSync(buffer, sessionId) {
        const reader = new BR(buffer);
        reader.readInt();
        const nonce = reader.readBytes(16);
        const serverNonce = reader.readBytes(16);
        const encryptedData = reader.readTlBytes();
        const state = this.getOrCreateAuthState(sessionId);
        const { key, iv } = generateKeyDataFromNonce(state.serverNonce, state.newNonce);
        const decrypted = new IGE(key, iv).decryptIge(encryptedData).slice(20);
        const innerReader = new BR(decrypted);
        innerReader.readInt();
        innerReader.readBytes(16);
        innerReader.readBytes(16);
        innerReader.readLong();
        const gB = innerReader.readTlBytes();
        const gab = modExp(readBigIntFromBuffer(gB, false), readBigIntFromBuffer(state.a, false), DH_PRIME);
        const authKey = readBufferFromBigInt(gab, 256);
        this.setAuthKey(sessionId, authKey);
        state.authKey = authKey;
        // Compute new_nonce_hash1 exactly as GramJS expects:
        // auxHash = sha1(auth_key)[0:8]
        // data = new_nonce(32 bytes LE) || byte(1) || auxHash(8 bytes LE)
        // new_nonce_hash1 = sha1(data)[4:20]
        const authKeySha1 = sha1Sync(authKey);
        const auxHash = authKeySha1.slice(0, 8);
        const newNonceBytes = state.newNonce; // already 32-byte buffer
        const hashData = Buffer.concat([
            newNonceBytes,
            Buffer.from([1]),
            auxHash,
        ]);
        const newNonceHash1 = sha1Sync(hashData).slice(4, 20);
        const dhGenOk = new BW();
        dhGenOk.writeInt(0x3bcbf734); // correct dh_gen_ok constructor ID
        dhGenOk.writeBytes(nonce);
        dhGenOk.writeBytes(serverNonce);
        dhGenOk.writeBytes(newNonceHash1);
        return dhGenOk.getBytes();
    }
}
class BR {
    buffer;
    offset = 0;
    constructor(data) {
        this.buffer = data;
    }
    readByte() {
        return this.buffer[this.offset++];
    }
    readInt(signed = true) {
        if (signed) {
            const result = this.buffer.readInt32LE(this.offset);
            this.offset += 4;
            return result;
        }
        const result = this.buffer.readUInt32LE(this.offset);
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
    readTlBytes() {
        const firstByte = this.readByte();
        let len;
        let headerLen;
        if (firstByte <= 253) {
            len = firstByte;
            headerLen = 1;
        }
        else {
            len = this.readByte() | (this.readByte() << 8) | (this.readByte() << 16);
            headerLen = 4;
        }
        const data = this.readBytes(len);
        const totalOccupied = headerLen + len;
        const padding = totalOccupied % 4 === 0 ? 0 : 4 - (totalOccupied % 4);
        if (padding > 0)
            this.readBytes(padding);
        return data;
    }
}
class BW {
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
        this.buffer.push(strBuffer);
        this.length += strBuffer.length;
    }
    getBytes() {
        return Buffer.concat(this.buffer);
    }
}
//# sourceMappingURL=auth.js.map