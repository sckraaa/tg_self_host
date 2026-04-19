/**
 * Conformance tests: compare self-hosted server responses against
 * official Telegram server fixtures.
 *
 * These tests boot the real server, connect via WebSocket,
 * perform full MTProto auth key exchange + API calls,
 * and compare response structures against captured fixtures.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import { randomBytes, publicEncrypt, constants } from 'crypto';
import {
  loadFixture,
  listFixtures,
  hasFixture,
  compareStructure,
  TlReader,
  type Fixture,
  type StructureDiff,
} from './helpers.js';
import { startServer } from '../src/mtproto/server.js';
import { getMessageStore } from '../src/database/messageStore.js';
import { sha256Sync, sha1Sync, IGE, CTR, generateRandomBytes, modExp as cryptoModExp, readBigIntFromBuffer, readBufferFromBigInt, bufferXor } from '../src/crypto/utils.js';
import { BinaryReader, BinaryWriter } from '../src/mtproto/codec.js';
import { writeTlString, writeTlBytes } from '../src/mtproto/tlHelpers.js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createPrivateKey, createPublicKey } from 'crypto';

const __test_dirname = dirname(fileURLToPath(import.meta.url));
const RSA_PRIVATE_KEY_PEM = readFileSync(resolve(__test_dirname, '../rsa_private.pem'), 'utf-8');
// Derive public key from private key to ensure they always match
const RSA_PUBLIC_KEY_PEM = createPublicKey(RSA_PRIVATE_KEY_PEM).export({ type: 'spki', format: 'pem' }) as string;

// ─── MTProto client helper (minimal) ────────────────────────────────

class TestMTProtoClient {
  private ws!: WebSocket;
  private authKey!: Buffer;
  private serverSalt = Buffer.alloc(8);
  private sessionId = randomBytes(8);
  private seqNo = 0;
  private encryptor!: CTR;
  private decryptor!: CTR;
  private lastMsgId = 0n;
  private pendingResponses = new Map<string, { resolve: (buf: Buffer) => void; timer: ReturnType<typeof setTimeout> }>();
  private receiveBuffer = Buffer.alloc(0);
  private connected = false;

  constructor(private port: number) {}

  /** Send invokeWithLayer(198) + initConnection wrapper so server knows our TL schema */
  async declareLayer(): Promise<void> {
    const w = new BinaryWriter();
    // invokeWithLayer#da9b0d0d layer:int query:X = X
    w.writeInt(0xda9b0d0d);
    w.writeInt(223); // layer — match web client fork

    // initConnection#c1cd5ea9 ... query:X = X
    w.writeInt(0xc1cd5ea9);
    w.writeInt(0); // flags
    w.writeInt(22280650); // api_id
    writeTlString(w, 'Test'); // device_model
    writeTlString(w, 'Test'); // system_version
    writeTlString(w, '1.0'); // app_version
    writeTlString(w, 'en'); // system_lang_code
    writeTlString(w, ''); // lang_pack
    writeTlString(w, 'en'); // lang_code

    // Inner query: help.getConfig
    w.writeInt(0xc4f9186b);

    await this.sendRequest(w.getBytes());
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
      this.ws.binaryType = 'arraybuffer';
      this.ws.on('open', () => {
        this.connected = true;
        resolve();
      });
      this.ws.on('error', reject);
      this.ws.on('message', (data: ArrayBuffer) => {
        this.handleMessage(Buffer.from(data));
      });
    });
  }

  async doAuthKeyExchange(): Promise<void> {
    // Step 1: Send obfuscation header
    const header = this.buildObfuscationHeader();
    this.ws.send(header);

    // Step 2: req_pq_multi
    const nonce = randomBytes(16);
    const reqPqPayload = new BinaryWriter();
    reqPqPayload.writeInt(0xbe7e8ef1); // req_pq_multi
    reqPqPayload.writeBytes(nonce);

    const resPq = await this.sendUnencrypted(reqPqPayload.getBytes());
    const resPqReader = new BinaryReader(resPq);
    const resPqConstructor = resPqReader.readInt() >>> 0;
    if (resPqConstructor !== 0x05162463) {
      throw new Error(`Expected resPQ (0x05162463), got 0x${resPqConstructor.toString(16)}`);
    }

    // Parse resPQ
    resPqReader.readBytes(16); // nonce echo
    const serverNonce = resPqReader.readBytes(16);
    // pq as TL bytes (with padding)
    const pq = readBinaryTlBytes(resPqReader);
    // Vector<long> fingerprints
    resPqReader.readInt(); // vector constructor 0x1cb5c415
    const fpCount = resPqReader.readInt();
    const fingerprint = resPqReader.readLong(false);

    // Step 3: req_DH_params with RSA_PAD encryption
    const newNonce = randomBytes(32);
    const p = Buffer.from([0x49, 0x4C, 0x55, 0x3B]); // Server's known p
    const q = Buffer.from([0x53, 0x91, 0x10, 0x73]); // Server's known q

    // Build p_q_inner_data
    const innerData = new BinaryWriter();
    innerData.writeInt(0x83c95aec); // p_q_inner_data constructor
    writeTlBytes(innerData, pq);
    writeTlBytes(innerData, p);
    writeTlBytes(innerData, q);
    innerData.writeBytes(nonce);
    innerData.writeBytes(serverNonce);
    innerData.writeBytes(newNonce);

    const innerBytes = innerData.getBytes();

    // RSA_PAD protocol (retry until toRsa < modulus):
    let rsaEncryptedBuf: Buffer;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // 1. Reverse inner data, pad at front to 192 bytes
      const reversedInner = Buffer.from(innerBytes).reverse();
      const paddedInner = Buffer.concat([
        randomBytes(192 - reversedInner.length),
        reversedInner,
      ]);

      // 2. Build 224-byte block: 192 bytes data + 32 bytes random
      const dataToEncrypt = Buffer.concat([paddedInner, randomBytes(32)]);

      // 3. IGE encrypt with random tempKey and zero IV
      const tempKey = randomBytes(32);
      const zeroIv = Buffer.alloc(32);
      const aesEncrypted = new IGE(tempKey, zeroIv).encryptIge(dataToEncrypt);

      // 4. XOR tempKey with sha256(aesEncrypted)
      const tempKeyXor = bufferXor(tempKey, sha256Sync(aesEncrypted));

      // 5. Combine: tempKeyXor(32) + aesEncrypted(224) = 256 bytes
      const toRsa = Buffer.concat([tempKeyXor, aesEncrypted]);

      // 6. RSA encrypt with server's public key (raw/no padding)
      // toRsa must be < modulus for RSA_NO_PADDING
      try {
        rsaEncryptedBuf = publicEncrypt(
          { key: RSA_PUBLIC_KEY_PEM, padding: constants.RSA_NO_PADDING },
          toRsa,
        );
        break; // success
      } catch {
        continue; // retry with new random padding
      }
    }

    const reqDH = new BinaryWriter();
    reqDH.writeInt(0xd712e4be); // req_DH_params
    reqDH.writeBytes(nonce);
    reqDH.writeBytes(serverNonce);
    writeTlBytes(reqDH, p);
    writeTlBytes(reqDH, q);
    reqDH.writeLong(fingerprint); // actual fingerprint from server
    writeTlBytes(reqDH, rsaEncryptedBuf);

    const dhParamsResp = await this.sendUnencrypted(reqDH.getBytes());
    const dhReader = new BinaryReader(dhParamsResp);
    const dhConstructor = dhReader.readInt() >>> 0;

    if (dhConstructor === 0xd0e8075c) {
      // server_DH_params_ok
      dhReader.readBytes(16); // nonce
      dhReader.readBytes(16); // server_nonce

      // Derive tmp_aes_key/iv from nonces
      const hash1 = sha1Sync(Buffer.concat([newNonce, serverNonce]));
      const hash2 = sha1Sync(Buffer.concat([serverNonce, newNonce]));
      const hash3 = sha1Sync(Buffer.concat([newNonce, newNonce]));

      const tmpAesKey = Buffer.concat([hash1, hash2.slice(0, 12)]);
      const tmpAesIv = Buffer.concat([hash2.slice(12), hash3, newNonce.slice(0, 4)]);

      // Read encrypted_answer as TL bytes
      const encryptedAnswer = readBinaryTlBytes(dhReader);

      // IGE decrypt
      const decrypted = new IGE(tmpAesKey, tmpAesIv).decryptIge(encryptedAnswer);

      // Parse server_DH_inner_data (skip sha1 hash at start)
      const innerReader = new BinaryReader(decrypted.slice(20));
      const innerCtor = innerReader.readInt() >>> 0;
      if (innerCtor !== 0xb5890dba) {
        throw new Error(`Expected server_DH_inner_data, got 0x${innerCtor.toString(16)}`);
      }

      innerReader.readBytes(16); // nonce
      innerReader.readBytes(16); // server_nonce
      const g = innerReader.readInt();
      const dhPrime = readBinaryTlBytes(innerReader);
      const gA = readBinaryTlBytes(innerReader);

      // Generate b, compute g_b and auth_key
      const prime = readBigIntFromBuffer(dhPrime, false);
      const gABig = readBigIntFromBuffer(gA, false);
      const bBig = readBigIntFromBuffer(randomBytes(256), false) % prime;

      const gBBig = cryptoModExp(BigInt(g), bBig, prime);
      const authKeyBig = cryptoModExp(gABig, bBig, prime);

      const gBBuf = readBufferFromBigInt(gBBig, 256);
      const authKeyBuf = readBufferFromBigInt(authKeyBig, 256);

      // Step 4: set_client_DH_params
      const clientInner = new BinaryWriter();
      clientInner.writeInt(0x6643b654); // client_DH_inner_data
      clientInner.writeBytes(nonce);
      clientInner.writeBytes(serverNonce);
      clientInner.writeLong(0n); // retry_id
      writeTlBytes(clientInner, gBBuf);

      const clientInnerBytes = clientInner.getBytes();
      const clientHash = sha1Sync(clientInnerBytes);
      const clientPadded = Buffer.concat([clientHash, clientInnerBytes]);
      const clientPadLen = (16 - (clientPadded.length % 16)) % 16;
      const clientFinal = Buffer.concat([clientPadded, randomBytes(clientPadLen)]);

      const clientEncrypted = new IGE(tmpAesKey, tmpAesIv).encryptIge(clientFinal);

      const setDH = new BinaryWriter();
      setDH.writeInt(0xf5045f1f); // set_client_DH_params
      setDH.writeBytes(nonce);
      setDH.writeBytes(serverNonce);
      writeTlBytes(setDH, clientEncrypted);

      const dhResult = await this.sendUnencrypted(setDH.getBytes());
      const dhResultCtor = dhResult.readUInt32LE(0) >>> 0;
      if (dhResultCtor !== 0x3bcbf734) {
        throw new Error(`Expected dh_gen_ok (0x3bcbf734), got 0x${dhResultCtor.toString(16)}`);
      }

      this.authKey = authKeyBuf;

      // Derive serverSalt from nonces
      const salt = Buffer.alloc(8);
      for (let i = 0; i < 8; i++) {
        salt[i] = newNonce[i] ^ serverNonce[i];
      }
      this.serverSalt = salt;
    } else {
      throw new Error(`DH params failed: 0x${dhConstructor.toString(16)}`);
    }
  }

  private buildObfuscationHeader(): Buffer {
    // Build 64-byte obfuscation header with efefefef tag
    const header = randomBytes(64);

    // Bytes 56-59 must be efefefef after decryption
    // The encryptKey = header[8:40], encryptIv = header[40:56]
    const decryptKey = Buffer.from(header.slice(8, 40));
    const decryptIv = Buffer.from(header.slice(40, 56));

    const reversed = Buffer.from(header.slice(8, 56)).reverse();
    const encryptKey = Buffer.from(reversed.slice(0, 32));
    const encryptIv = Buffer.from(reversed.slice(32, 48));

    // We need the server's decryptor (our encryptor) to see efefefef at bytes 56-59
    const clientEncryptor = new CTR(decryptKey, decryptIv);
    const tempDecrypted = clientEncryptor.decrypt(Buffer.from(header));

    // Rewrite byte 56-59 in encrypted form so decryption yields efefefef
    const clientEncryptor2 = new CTR(decryptKey, decryptIv);
    const decrypted2 = clientEncryptor2.decrypt(Buffer.from(header));
    // Set efefefef in "decrypted" version
    decrypted2[56] = 0xef;
    decrypted2[57] = 0xef;
    decrypted2[58] = 0xef;
    decrypted2[59] = 0xef;

    // Re-encrypt
    const clientEncryptor3 = new CTR(decryptKey, decryptIv);
    const newHeader = clientEncryptor3.encrypt(decrypted2);

    // Set up our encryptor/decryptor using the reversed keys
    this.decryptor = new CTR(encryptKey, encryptIv);
    this.encryptor = new CTR(decryptKey, decryptIv);

    // Advance encryptor by 64 bytes (header was encrypted by it)
    this.encryptor.encrypt(Buffer.alloc(64));

    return newHeader;
  }

  private generateMsgId(): bigint {
    const nowMs = BigInt(Date.now());
    const sec = nowMs / 1000n;
    const ns = (nowMs % 1000n) * 1000000n;
    let msgId = (sec << 32n) | (ns << 2n);
    if (msgId <= this.lastMsgId) msgId = this.lastMsgId + 4n;
    this.lastMsgId = msgId;
    return msgId;
  }

  private sendUnencrypted(payload: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const msgId = this.generateMsgId();

      const envelope = Buffer.alloc(20 + payload.length);
      // auth_key_id = 0 (8 bytes)
      envelope.writeBigInt64LE(0n, 0);
      // msg_id
      envelope.writeBigInt64LE(msgId, 8);
      // msg_len
      envelope.writeInt32LE(payload.length, 16);
      payload.copy(envelope, 20);

      // Abridged framing
      const length = envelope.length >> 2;
      let frame: Buffer;
      if (length < 127) {
        frame = Buffer.concat([Buffer.from([length]), envelope]);
      } else {
        const hdr = Buffer.alloc(4);
        hdr[0] = 0x7f;
        hdr[1] = length & 0xff;
        hdr[2] = (length >> 8) & 0xff;
        hdr[3] = (length >> 16) & 0xff;
        frame = Buffer.concat([hdr, envelope]);
      }

      const encrypted = this.encryptor.encrypt(frame);

      const key = msgId.toString();
      const timer = setTimeout(() => {
        this.pendingResponses.delete(key);
        reject(new Error(`Timeout waiting for response to msgId ${key}`));
      }, 5000);
      this.pendingResponses.set(key, { resolve, timer });

      this.ws.send(encrypted);
    });
  }

  /** Send an encrypted API request and return the rpc_result body */
  sendRequest(tlPayload: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const msgId = this.generateMsgId();
      this.seqNo += 2;

      // Build inner message
      const innerW = new BinaryWriter();
      innerW.writeBytes(this.serverSalt);
      innerW.writeBytes(this.sessionId);
      innerW.writeLong(msgId);
      innerW.writeInt(this.seqNo | 1); // content-related
      innerW.writeInt(tlPayload.length);
      innerW.writeBytes(tlPayload);

      const innerBytes = innerW.getBytes();
      let paddingLen = 12 + ((16 - ((innerBytes.length + 12) % 16)) % 16);
      if (paddingLen < 12) paddingLen += 16;
      const padded = Buffer.concat([innerBytes, randomBytes(paddingLen)]);

      // msg_key (client→server: x=0)
      const msgKeyFull = sha256Sync(Buffer.concat([this.authKey.slice(88, 120), padded]));
      const msgKey = msgKeyFull.slice(8, 24);

      const sha256a = sha256Sync(Buffer.concat([msgKey, this.authKey.slice(0, 36)]));
      const sha256b = sha256Sync(Buffer.concat([this.authKey.slice(40, 76), msgKey]));
      const aesKey = Buffer.concat([sha256a.slice(0, 8), sha256b.slice(8, 24), sha256a.slice(24, 32)]);
      const aesIv = Buffer.concat([sha256b.slice(0, 8), sha256a.slice(8, 24), sha256b.slice(24, 32)]);

      const ige = new IGE(aesKey, aesIv);
      const encrypted = ige.encryptIge(padded);

      // auth_key_id
      const authKeyHash = sha1Sync(this.authKey);
      const authKeyIdBuf = authKeyHash.slice(12, 20);

      const outerEnvelope = Buffer.concat([authKeyIdBuf, msgKey, encrypted]);

      // Abridged frame
      const length = outerEnvelope.length >> 2;
      let frame: Buffer;
      if (length < 127) {
        frame = Buffer.concat([Buffer.from([length]), outerEnvelope]);
      } else {
        const hdr = Buffer.alloc(4);
        hdr[0] = 0x7f;
        hdr[1] = length & 0xff;
        hdr[2] = (length >> 8) & 0xff;
        hdr[3] = (length >> 16) & 0xff;
        frame = Buffer.concat([hdr, outerEnvelope]);
      }

      const ctrEncrypted = this.encryptor.encrypt(frame);

      const key = msgId.toString();
      const timer = setTimeout(() => {
        this.pendingResponses.delete(key);
        reject(new Error(`Timeout waiting for rpc_result of msgId ${key}`));
      }, 5000);
      this.pendingResponses.set(key, { resolve, timer });

      this.ws.send(ctrEncrypted);
    });
  }

  private handleMessage(data: Buffer) {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);

    while (this.receiveBuffer.length > 0) {
      // Decrypt via CTR
      const decrypted = this.decryptor.decrypt(Buffer.from(this.receiveBuffer));

      // Parse abridged frame length
      let msgLen: number;
      let headerLen: number;
      if (decrypted[0] >= 0x7f) {
        if (decrypted.length < 4) return;
        msgLen = (decrypted[1] | (decrypted[2] << 8) | (decrypted[3] << 16)) << 2;
        headerLen = 4;
      } else {
        msgLen = decrypted[0] << 2;
        headerLen = 1;
      }

      if (decrypted.length < headerLen + msgLen) return;

      const envelopeData = decrypted.slice(headerLen, headerLen + msgLen);
      this.receiveBuffer = Buffer.from(decrypted.slice(headerLen + msgLen));

      // Check if unencrypted (auth_key_id == 0)
      const authKeyId = envelopeData.readBigInt64LE(0);
      if (authKeyId === 0n) {
        // Unencrypted response: auth_key_id(8) + msg_id(8) + length(4) + data
        const innerPayload = envelopeData.slice(20);
        // Resolve the first pending request (unencrypted responses come in order)
        const firstKey = this.pendingResponses.keys().next().value;
        if (firstKey) {
          const pending = this.pendingResponses.get(firstKey);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingResponses.delete(firstKey);
            pending.resolve(innerPayload);
          }
        }
      } else {
        // Encrypted response: auth_key_id(8) + msg_key(16) + encrypted_data
        const result = this.decryptEncryptedMessage(envelopeData);
        if (result) {
          this.processDecryptedMessage(result);
        }
      }
    }
  }

  private decryptEncryptedMessage(data: Buffer): Buffer | null {
    if (!this.authKey || data.length < 24) return null;

    const msgKey = data.slice(8, 24);
    const encrypted = data.slice(24);

    // server→client: x=8
    const sha256a = sha256Sync(Buffer.concat([msgKey, this.authKey.slice(8, 44)]));
    const sha256b = sha256Sync(Buffer.concat([this.authKey.slice(48, 84), msgKey]));
    const aesKey = Buffer.concat([sha256a.slice(0, 8), sha256b.slice(8, 24), sha256a.slice(24, 32)]);
    const aesIv = Buffer.concat([sha256b.slice(0, 8), sha256a.slice(8, 24), sha256b.slice(24, 32)]);

    const ige = new IGE(aesKey, aesIv);
    const decrypted = ige.decryptIge(encrypted);

    // server_salt(8) + session_id(8) + message_id(8) + seq_no(4) + msg_data_len(4) + data
    const msgDataLen = decrypted.readInt32LE(28);
    return decrypted.slice(32, 32 + msgDataLen);
  }

  private processDecryptedMessage(data: Buffer) {
    const constructorId = data.readUInt32LE(0) >>> 0;

    // new_session_created — skip
    if (constructorId === 0x9ec20908) return;

    // msg_container — process children
    if (constructorId === 0x73f1f8dc) {
      const count = data.readInt32LE(4);
      let offset = 8;
      for (let i = 0; i < count; i++) {
        if (offset + 16 > data.length) break;
        offset += 8; // msg_id
        offset += 4; // seq_no
        const bodyLen = data.readInt32LE(offset); offset += 4;
        const body = data.slice(offset, offset + bodyLen); offset += bodyLen;
        this.processDecryptedMessage(body);
      }
      return;
    }

    // rpc_result — extract inner response
    if (constructorId === 0xf35c6d01) {
      const reqMsgId = data.readBigInt64LE(4);
      const innerData = data.slice(12);
      const key = reqMsgId.toString();
      const pending = this.pendingResponses.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingResponses.delete(key);
        pending.resolve(innerData);
      }
      return;
    }

    // Pong
    if (constructorId === 0x347773c5) {
      const firstKey = this.pendingResponses.keys().next().value;
      if (firstKey) {
        const pending = this.pendingResponses.get(firstKey);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingResponses.delete(firstKey);
          pending.resolve(data);
        }
      }
    }
  }

  disconnect() {
    for (const [, pending] of this.pendingResponses) {
      clearTimeout(pending.timer);
    }
    this.pendingResponses.clear();
    if (this.ws) this.ws.close();
  }
}

// ─── Utility ────────────────────────────────────────────────────────

/** Read TL bytes with proper padding alignment from a BinaryReader */
function readBinaryTlBytes(reader: BinaryReader): Buffer {
  const firstByte = reader.readByte();
  let len: number;
  let headerLen: number;
  if (firstByte <= 253) {
    len = firstByte;
    headerLen = 1;
  } else {
    const b = reader.readBytes(3);
    len = b[0] | (b[1] << 8) | (b[2] << 16);
    headerLen = 4;
  }
  const data = reader.readBytes(len);
  const totalOccupied = headerLen + len;
  const padding = totalOccupied % 4 === 0 ? 0 : 4 - (totalOccupied % 4);
  if (padding > 0) reader.readBytes(padding);
  return data;
}

/**
 * Extract the constructor ID from our server's binary response.
 * Returns 0 for empty/too-short buffers.
 */
function getResponseCtor(resp: Buffer): number {
  if (resp.length < 4) return 0;
  return resp.readUInt32LE(0) >>> 0;
}

/**
 * Get the official constructor ID from a fixture response.
 * Returns 0 if missing.
 */
function getFixtureCtor(fixture: Fixture | undefined): number {
  if (!fixture?.response) return 0;
  return (fixture.response.__constructorId ?? 0) >>> 0;
}

// ─── Official TL Constructor IDs (web client fork, Layer 223) ──────────
// These are the constructors expected by the Telegram A web client.
// Our server MUST return these when talking to the web client.

const OFFICIAL = {
  // Core types
  boolTrue:                   0x997275b5,
  boolFalse:                  0xbc799737,
  config:                     0xcc1a241e,
  updatesState:               0xa56c2a3e,
  rpcError:                   0x2144ca19,
  vector:                     0x1cb5c415,
  authSentCode:               0x5e002502,
  authAuthorization:          0x2ea2c0d4,
  authSignUpRequired:         0x44747e9a,

  // messages
  messagesDialogs:            0x15ba6c40,
  messagesDialogsSlice:       0x71e094f3,
  messagesMessages:           0x1d73e7ea,
  messagesMessagesSlice:      0x5f206716,
  messagesChannelMessages:    0xc776ba4e,
  messagesDialogFilters:      0x2ad93719,
  messagesPeerDialogs:        0x3371c354,
  messagesAffectedMessages:   0x84d19185,
  messagesChatFull:           0xe5d7d19c,
  messagesInvitedUsers:       0x7f5defa6,
  messagesWebPagePreview:     0x8c9a88ac,
  messagesSavedDialogs:       0xf83ae221,
  messagesQuickReplies:       0xc68d6695,
  messagesAvailableReactions: 0x768e3aad,
  messagesAllStickers:        0xcdbbcebb,
  messagesFeaturedStickers:   0xbe382906,
  messagesRecentStickers:     0x88d37c56,
  messagesSavedGifs:          0x84a02a0d,
  messagesFavedStickers:      0x2cb51097,
  messagesReactions:          0xeafdf716,
  messagesStickerSet:         0x6e153f16,
  messagesSavedReactionTagsNotModified: 0x889b59ef,
  messagesDefaultTagReactions: 0xeafdf716,

  // updates
  updates:                    0x74ae4240,
  updateShortSentMessage:     0x9015e101,
  updateShort:                0x78d4dec1,
  updatesDifference:          0x00f49ca0,

  // contacts
  contactsFound:              0xb3134d9d,
  contactsResolvedPeer:       0x7f077ad9,
  contactsContacts:           0xeae87e42,
  contactsTopPeers:           0x70b772a8,
  contactsBlocked:            0x0ade1591,

  // channels
  channelParticipants:        0x9ab0feaf,

  // users
  usersUserFull:              0x3b6d152e,

  // account
  accountAuthorizations:      0x4bff8ea0,
  accountPassword:            0x957b50fb,
  accountWallPapers:          0xcdc3858c,
  accountContentSettings:     0x57e28221,
  accountPrivacyRules:        0x50a04e45,
  globalPrivacySettings:      0xfe41b34f,
  peerNotifySettings:         0x99622c0c,

  // help
  helpAppConfig:              0xdd18782e,
  helpCountriesList:          0x87d0759e,
  helpTimezonesList:          0x7b74ed71,
  helpPeerColors:             0x00f8ed08,
  nearestDc:                  0x8e1a1775,

  // langpack
  langPackDifference:         0xf385c1f6,

  // attachMenu
  attachMenuBots:             0x3c4301c0,

  // emoji / keywords
  emojiKeywordsDifference:    0x5cc761bd,
  defaultHistoryTTL:          0x43b46b20,

  // payments
  paymentsStarsStatus:        0x6c9ce8ed,
  paymentsStarGifts:          0x2ed82995,
  paymentsSavedStarGifts:     0x95f389b1,

  // stories
  storiesAllStories:          0x6efc5e81,

  // more messages
  messagesAvailableEffects:   0xbddb616e,
  messagesChatInviteImporters: 0x81b6b00a,
  messagesExportedChatInvites: 0xbdc62dcc,
  messagesSponsoredMessagesEmpty: 0x1839490f,
  messagesStickers:           0x30a6ec7e,
  messagesScheduledMessages:  0x1d73e7ea, // same as messagesMessages (web client)

  // more channels
  channelsChannelParticipant: 0xdfb80317,

  // more account
  accountEmojiStatuses:       0x90c467d1,
  user:                       0x31774388,

  // more help
  helpPromoDataEmpty:         0x98f6ac75,
  helpTermsOfServiceUpdateEmpty: 0xe3309f7f,

  // more langpack
  langPackLanguage:           0xeeca5ce3,

  // emoji
  emojiURL:                   0xa575739d,
} as const;

// All valid constructors that official Telegram uses for getHistory responses
const OFFICIAL_GET_HISTORY_CTORS = [
  OFFICIAL.messagesMessages,         // messages.Messages (small chat)
  OFFICIAL.messagesMessagesSlice,    // messages.MessagesSlice (user P2P)
  OFFICIAL.messagesChannelMessages,  // messages.ChannelMessages (channel)
];

// All valid constructors for sendMessage responses
const OFFICIAL_SEND_MESSAGE_CTORS = [
  OFFICIAL.updateShortSentMessage,   // P2P user messages
  OFFICIAL.updates,                  // channel/group messages
];

// ─── Test suite ─────────────────────────────────────────────────────

describe('Server Conformance Tests', () => {
  let serverInfo: ReturnType<typeof startServer>;
  let client: TestMTProtoClient;
  const PORT = 18080 + Math.floor(Math.random() * 1000);

  beforeAll(async () => {
    serverInfo = startServer(PORT, '127.0.0.1');
    await new Promise(r => setTimeout(r, 200));

    client = new TestMTProtoClient(PORT);
    await client.connect();
    await client.doAuthKeyExchange();
    await client.declareLayer();
    await new Promise(r => setTimeout(r, 100));
  }, 15000);

  afterAll(() => {
    client?.disconnect();
    serverInfo?.server?.close();
  });

  // ═══════════════════════════════════════════════════════════════
  // 1. AUTH KEY EXCHANGE
  // ═══════════════════════════════════════════════════════════════

  describe('Auth Key Exchange', () => {
    it('should complete full DH auth key exchange', () => {
      expect(true).toBe(true); // beforeAll succeeded
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 2. UNAUTHENTICATED CALLS
  // ═══════════════════════════════════════════════════════════════

  describe('help.getConfig', () => {
    it('should return official Config constructor', async () => {
      const fixture = loadFixture('help.getConfig');
      expect(fixture?.response).toBeDefined();

      const req = Buffer.alloc(4);
      req.writeUInt32LE(0xc4f9186b, 0);
      const resp = await client.sendRequest(req);
      const ctor = getResponseCtor(resp);

      // Must match the exact constructor from official Telegram
      expect(ctor).toBe(getFixtureCtor(fixture));
    });

    it('should include date and expires fields', async () => {
      const req = Buffer.alloc(4);
      req.writeUInt32LE(0xc4f9186b, 0);
      const resp = await client.sendRequest(req);

      const reader = new BinaryReader(resp);
      expect(reader.readInt() >>> 0).toBe(OFFICIAL.config);
      reader.readInt(); // flags
      const date = reader.readInt();
      const expires = reader.readInt();
      expect(date).toBeGreaterThan(0);
      expect(expires).toBeGreaterThan(date);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 3. AUTHENTICATED API CALLS
  // ═══════════════════════════════════════════════════════════════

  describe('Authenticated API', () => {
    let authedClient: TestMTProtoClient;

    beforeAll(async () => {
      authedClient = new TestMTProtoClient(PORT);
      await authedClient.connect();
      await authedClient.doAuthKeyExchange();
      await authedClient.declareLayer();
      await new Promise(r => setTimeout(r, 100));

      // — auth.sendCode —
      const phone = '+79991234567';
      const sendCodeW = new BinaryWriter();
      sendCodeW.writeInt(0xa677244f);
      writeTlString(sendCodeW, phone);
      const sendCodeResp = await authedClient.sendRequest(sendCodeW.getBytes());
      const sendCodeCtor = getResponseCtor(sendCodeResp);
      if (sendCodeCtor === OFFICIAL.rpcError) throw new Error('auth.sendCode returned RPC error');

      // Parse phone_code_hash from auth.sentCode
      const scReader = new BinaryReader(sendCodeResp);
      scReader.readInt(); // constructor
      scReader.readInt(); // flags
      scReader.readInt(); // type constructor
      scReader.readInt(); // type length field
      const hashLen = scReader.readByte();
      const codeHash = scReader.readBytes(hashLen).toString('utf8');

      // Get code from DB (it's our server)
      const store = getMessageStore();
      const codes = (store as any).db?.prepare(
        'SELECT code FROM auth_codes WHERE phone = ? LIMIT 1'
      )?.get(phone) as { code: string } | undefined;
      const code = codes?.code || '12345';

      // — auth.signIn —
      const signInW = new BinaryWriter();
      signInW.writeInt(0x8d52a951);
      signInW.writeInt(1); // flags: phone_code present
      writeTlString(signInW, phone);
      writeTlString(signInW, codeHash);
      writeTlString(signInW, code);
      const signInResp = await authedClient.sendRequest(signInW.getBytes());
      const signInCtor = getResponseCtor(signInResp);

      if (signInCtor === OFFICIAL.authSignUpRequired) {
        const signUpW = new BinaryWriter();
        signUpW.writeInt(0xaac7b717);
        signUpW.writeInt(0);
        writeTlString(signUpW, phone);
        writeTlString(signUpW, codeHash);
        writeTlString(signUpW, 'Test');
        writeTlString(signUpW, 'User');
        const signUpResp = await authedClient.sendRequest(signUpW.getBytes());
        expect(getResponseCtor(signUpResp)).toBe(OFFICIAL.authAuthorization);
      }
    }, 15000);

    afterAll(() => { authedClient?.disconnect(); });

    // ──── updates.getState ─────────────────────────────────────

    describe('updates.getState', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('updates.getState');
        expect(fixture?.response).toBeDefined();

        const req = Buffer.alloc(4);
        req.writeUInt32LE(0xedd4882a, 0);
        const resp = await authedClient.sendRequest(req);

        expect(getResponseCtor(resp)).toBe(getFixtureCtor(fixture));
      });

      it('should return pts/qts/date/seq/unreadCount fields', async () => {
        const req = Buffer.alloc(4);
        req.writeUInt32LE(0xedd4882a, 0);
        const resp = await authedClient.sendRequest(req);

        const reader = new BinaryReader(resp);
        expect(reader.readInt() >>> 0).toBe(OFFICIAL.updatesState);
        const pts = reader.readInt();
        const qts = reader.readInt();
        const date = reader.readInt();
        const seq = reader.readInt();
        const unreadCount = reader.readInt();

        expect(pts).toBeGreaterThanOrEqual(0);
        expect(date).toBeGreaterThan(0);
        expect(seq).toBeGreaterThanOrEqual(0);
        expect(unreadCount).toBeGreaterThanOrEqual(0);
      });
    });

    // ──── users.getUsers ──────────────────────────────────────

    describe('users.getUsers', () => {
      it('should return Vector of User', async () => {
        const w = new BinaryWriter();
        w.writeInt(0x0d91a548);
        w.writeInt(OFFICIAL.vector);
        w.writeInt(1);
        w.writeInt(0xf7c1b13f); // inputUserSelf

        const resp = await authedClient.sendRequest(w.getBytes());
        const reader = new BinaryReader(resp);
        expect(reader.readInt() >>> 0).toBe(OFFICIAL.vector);

        const count = reader.readInt();
        expect(count).toBeGreaterThanOrEqual(1);
      });
    });

    // ──── messages.getDialogs ──────────────────────────────────

    describe('messages.getDialogs', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('messages.getDialogs');
        expect(fixture?.response).toBeDefined();

        const w = new BinaryWriter();
        w.writeInt(0xa0f4cb4f);
        w.writeInt(0); // flags
        w.writeInt(0); // offsetDate
        w.writeInt(0); // offsetId
        w.writeInt(0x7f3b18ea); // inputPeerEmpty
        w.writeInt(20); // limit
        w.writeLong(0n); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // Official uses messages.Dialogs (0x15ba6c40). Our server must use same type.
        expect(ctor).toBe(getFixtureCtor(fixture));
      });
    });

    // ──── messages.getDialogFilters ────────────────────────────

    describe('messages.getDialogFilters', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('messages.getDialogFilters');
        expect(fixture?.response).toBeDefined();

        const w = new BinaryWriter();
        w.writeInt(0xefd48c89);

        const resp = await authedClient.sendRequest(w.getBytes());
        expect(getResponseCtor(resp)).toBe(getFixtureCtor(fixture));
      });
    });

    // ──── messages.getHistory ──────────────────────────────────

    describe('messages.getHistory', () => {
      it('should return official getHistory constructor', async () => {
        const w = new BinaryWriter();
        w.writeInt(0x4423e6c5);
        w.writeInt(0x7da07ec9); // inputPeerSelf
        w.writeInt(0); w.writeInt(0); w.writeInt(0);
        w.writeInt(10); w.writeInt(0); w.writeInt(0);
        w.writeLong(0n);

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // Must be one of the OFFICIAL constructors Telegram uses for getHistory
        expect(OFFICIAL_GET_HISTORY_CTORS).toContain(ctor);
      });
    });

    // ──── messages.sendMessage ────────────────────────────────

    describe('messages.sendMessage', () => {
      it('should return official sendMessage response type', async () => {
        const fixture = loadFixture('messages.sendMessage__user');

        const w = new BinaryWriter();
        w.writeInt(0x545cd15a);
        w.writeInt(0); // flags
        w.writeInt(0x7da07ec9); // inputPeerSelf
        writeTlString(w, `conformance test ${Date.now()}`);
        w.writeLong(BigInt(Math.floor(Math.random() * 2 ** 53)));

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // Official Telegram returns UpdateShortSentMessage for P2P.
        // Our server must also return one of the official Updates types.
        expect(OFFICIAL_SEND_MESSAGE_CTORS).toContain(ctor);

        if (fixture?.response) {
          // For P2P, the official response is UpdateShortSentMessage
          expect(getFixtureCtor(fixture)).toBe(OFFICIAL.updateShortSentMessage);
        }
      });
    });

    // ──── messages.editMessage ─────────────────────────────────

    describe('messages.editMessage', () => {
      it('should return Updates (not RPC error)', async () => {
        // Send a message first
        const sendW = new BinaryWriter();
        sendW.writeInt(0x545cd15a); sendW.writeInt(0);
        sendW.writeInt(0x7da07ec9);
        writeTlString(sendW, 'edit me');
        sendW.writeLong(BigInt(Math.floor(Math.random() * 2 ** 53)));
        const sendResp = await authedClient.sendRequest(sendW.getBytes());
        const sendCtor = getResponseCtor(sendResp);

        // Extract msg ID
        let msgId = 0;
        if (sendCtor === OFFICIAL.updates) {
          const reader = new BinaryReader(sendResp);
          reader.readInt(); // ctor
          const updVecCtor = reader.readInt();
          const updCount = reader.readInt();
          for (let i = 0; i < updCount; i++) {
            const c = reader.peekConstructorId() >>> 0;
            if (c === 0x4e90bfd6) { // updateMessageID
              reader.readInt(); msgId = reader.readInt(); break;
            }
            break;
          }
        }

        if (msgId > 0) {
          const editW = new BinaryWriter();
          editW.writeInt(0x51e842e1);
          editW.writeInt(1 << 11); // flags: message
          editW.writeInt(0x7da07ec9);
          editW.writeInt(msgId);
          writeTlString(editW, 'edited text');

          const editResp = await authedClient.sendRequest(editW.getBytes());
          const editCtor = getResponseCtor(editResp);

          // Official Telegram returns Updates for editMessage
          expect(editCtor).toBe(OFFICIAL.updates);
        }
      });
    });

    // ──── messages.deleteMessages ─────────────────────────────

    describe('messages.deleteMessages', () => {
      it('should return messages.AffectedMessages with official constructor', async () => {
        const delW = new BinaryWriter();
        delW.writeInt(0xe58e95d2);
        delW.writeInt(1); // revoke
        delW.writeInt(OFFICIAL.vector);
        delW.writeInt(1);
        delW.writeInt(999999); // nonexistent ID — should still respond

        const delResp = await authedClient.sendRequest(delW.getBytes());
        expect(getResponseCtor(delResp)).toBe(OFFICIAL.messagesAffectedMessages);

        const reader = new BinaryReader(delResp);
        reader.readInt(); // ctor
        const pts = reader.readInt();
        const ptsCount = reader.readInt();
        expect(pts).toBeGreaterThanOrEqual(0);
        expect(ptsCount).toBeGreaterThanOrEqual(0);
      });
    });

    // ──── messages.readHistory ────────────────────────────────

    describe('messages.readHistory', () => {
      it('should return messages.AffectedMessages', async () => {
        const w = new BinaryWriter();
        w.writeInt(0x0e306d3a);
        w.writeInt(0x7da07ec9); // inputPeerSelf
        w.writeInt(999999);

        const resp = await authedClient.sendRequest(w.getBytes());
        expect(getResponseCtor(resp)).toBe(OFFICIAL.messagesAffectedMessages);
      });
    });

    // ──── contacts.search ────────────────────────────────────

    describe('contacts.search', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('contacts.search__test');
        expect(fixture?.response).toBeDefined();

        const w = new BinaryWriter();
        w.writeInt(0x11f812d8);
        writeTlString(w, 'test');
        w.writeInt(10);

        const resp = await authedClient.sendRequest(w.getBytes());
        expect(getResponseCtor(resp)).toBe(getFixtureCtor(fixture));
      });
    });

    // ──── contacts.resolveUsername ────────────────────────────

    describe('contacts.resolveUsername', () => {
      it('should return contacts.ResolvedPeer or RPC error', async () => {
        const store = getMessageStore();
        const uniquePhone = `+7999${Date.now() % 10000000}`;
        try { store.createUser(uniquePhone, 'Resolved', 'User'); } catch { /* */ }
        const allUsers = store.getAllUsers();
        const lastUser = allUsers[allUsers.length - 1];
        if (lastUser) store.updateUser(lastUser.id, { username: 'testresolved' });

        const w = new BinaryWriter();
        w.writeInt(0x725afbbc);
        w.writeInt(0); // flags
        writeTlString(w, 'testresolved');

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // Official constructor for resolveUsername
        expect([OFFICIAL.contactsResolvedPeer, OFFICIAL.rpcError]).toContain(ctor);
      });
    });

    // ──── messages.getPeerDialogs ────────────────────────────

    describe('messages.getPeerDialogs', () => {
      it('should match official constructor', async () => {
        // We have fixtures — official uses messages.PeerDialogs (0x3371c354)
        const fixture = loadFixture('messages.getPeerDialogs__chat_5256854084') ||
                        loadFixture('messages.getPeerDialogs__chat_5095384911');

        const w = new BinaryWriter();
        w.writeInt(0xe470bcfd); // messages.getPeerDialogs
        w.writeInt(OFFICIAL.vector); // Vector<InputDialogPeer>
        w.writeInt(1);
        // InputDialogPeer = inputDialogPeer#fcec9bc (peer)
        w.writeInt(0xfcec9bc);
        w.writeInt(0x7da07ec9); // inputPeerSelf

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        if (fixture?.response) {
          expect(ctor).toBe(getFixtureCtor(fixture));
        } else {
          expect(ctor).toBe(OFFICIAL.messagesPeerDialogs);
        }
      });
    });

    // ──── messages.getPinnedDialogs ──────────────────────────

    describe('messages.getPinnedDialogs', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('messages.getPinnedDialogs');

        const w = new BinaryWriter();
        w.writeInt(0xd6b94df2); // messages.getPinnedDialogs
        w.writeInt(0); // folderId

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        if (fixture?.response) {
          // Official is messages.PeerDialogs (0x3371c354)
          expect(ctor).toBe(getFixtureCtor(fixture));
        } else {
          expect(ctor).toBe(OFFICIAL.messagesPeerDialogs);
        }
      });
    });

    // ──── messages.search ────────────────────────────────────

    describe('messages.search', () => {
      it('should return official Messages constructor', async () => {
        const fixture = loadFixture('messages.search__chat_5256854084') ||
                        loadFixture('messages.search__chat_5095384911');

        const w = new BinaryWriter();
        w.writeInt(0x29ee847a); // messages.search
        w.writeInt(0);          // flags
        w.writeInt(0x7da07ec9); // inputPeerSelf
        writeTlString(w, 'test'); // q
        w.writeInt(0x7f3b18ea); // inputPeerEmpty (from_id)
        w.writeInt(0); // saved_peer_id absent
        // top_msg_id absent
        w.writeInt(0xb68b7a8f); // inputMessagesFilterEmpty
        w.writeInt(0); // min_date
        w.writeInt(0); // max_date
        w.writeInt(0); // offset_id
        w.writeInt(0); // add_offset
        w.writeInt(10); // limit
        w.writeInt(0); // max_id
        w.writeInt(0); // min_id
        w.writeLong(0n); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // Official uses messages.Messages (0x8c718e87) for search
        if (fixture?.response) {
          const officialCtor = getFixtureCtor(fixture);
          expect([officialCtor, OFFICIAL.messagesMessages, OFFICIAL.messagesMessagesSlice]).toContain(ctor);
        } else {
          expect([OFFICIAL.messagesMessages, OFFICIAL.messagesMessagesSlice]).toContain(ctor);
        }
      });
    });

    // ──── channels (from fixtures) ──────────────────────────────

    describe('channels.getParticipants', () => {
      it('fixture should use official constructor', () => {
        const fixture = loadFixture('channels.getParticipants');
        if (!fixture?.response) return;
        expect(getFixtureCtor(fixture)).toBe(OFFICIAL.channelParticipants);
      });
    });

    describe('channels.getFullChannel', () => {
      it('fixture should use official constructor', () => {
        const fixture = loadFixture('channels.getFullChannel');
        if (!fixture?.response) return;
        expect(getFixtureCtor(fixture)).toBe(OFFICIAL.messagesChatFull);
      });
    });

    describe('channels.createChannel', () => {
      it('fixture should use official Updates constructor', () => {
        const fixture = loadFixture('channels.createChannel');
        if (!fixture?.response) return;
        expect(getFixtureCtor(fixture)).toBe(OFFICIAL.updates);
      });
    });

    // ──── users.getFullUser ──────────────────────────────────

    describe('users.getFullUser', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('users.getFullUser__self');

        const w = new BinaryWriter();
        w.writeInt(0xb60f5918); // users.getFullUser
        w.writeInt(0xf7c1b13f); // inputUserSelf

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        if (fixture?.response) {
          expect(ctor).toBe(getFixtureCtor(fixture));
        } else {
          expect(ctor).toBe(OFFICIAL.usersUserFull);
        }
      });
    });

    // ──── contacts.getContacts ──────────────────────────────

    describe('contacts.getContacts', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('contacts.getContacts');

        const w = new BinaryWriter();
        w.writeInt(0x5dd69e12); // contacts.getContacts
        w.writeLong(0n); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        if (fixture?.response) {
          expect(ctor).toBe(getFixtureCtor(fixture));
        }
      });
    });

    // ──── updates.getDifference ──────────────────────────────

    describe('updates.getDifference', () => {
      it('should return an official updates.Difference type', async () => {
        const fixture = loadFixture('updates.getDifference');

        const w = new BinaryWriter();
        w.writeInt(0x19c2f763); // updates.getDifference
        w.writeInt(0); // flags
        w.writeInt(0); // pts
        w.writeInt(0); // ptsTotalLimit absent
        w.writeInt(0); // date
        w.writeInt(0); // qts

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        const validCtors = [
          OFFICIAL.updatesDifference,  // updates.Difference
          0x4afe8f6d,                  // updates.DifferenceSlice
          0x5d75a138,                  // updates.DifferenceEmpty
          0x4a25eb5e,                  // updates.DifferenceTooLong
        ];
        expect(validCtors).toContain(ctor);
      });
    });

    // ──── messages.saveDraft ──────────────────────────────────

    describe('messages.saveDraft', () => {
      it('should return boolTrue', async () => {
        const w = new BinaryWriter();
        w.writeInt(0x7ff3b806); // messages.saveDraft
        w.writeInt(0); // flags
        w.writeInt(0x7da07ec9); // inputPeerSelf
        writeTlString(w, 'test draft');

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // Official returns Bool (boolTrue=0x997275b5 or boolFalse=0xbc799737)
        expect([OFFICIAL.boolTrue, OFFICIAL.boolFalse]).toContain(ctor);
      });
    });

    // ──── help.getAppConfig ──────────────────────────────────

    describe('help.getAppConfig', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('help.getAppConfig');

        const w = new BinaryWriter();
        w.writeInt(0x61e3f854); // help.getAppConfig (new with hash)
        w.writeInt(0); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        if (fixture?.response) {
          expect(ctor).toBe(getFixtureCtor(fixture));
        } else {
          expect(ctor).toBe(OFFICIAL.helpAppConfig);
        }
      });
    });

    // ──── help.getCountriesList ─────────────────────────────

    describe('help.getCountriesList', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('help.getCountriesList');

        const w = new BinaryWriter();
        w.writeInt(0x735787a8); // help.getCountriesList
        writeTlString(w, 'en');
        w.writeInt(0); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        if (fixture?.response) {
          expect(ctor).toBe(getFixtureCtor(fixture));
        } else {
          expect(ctor).toBe(OFFICIAL.helpCountriesList);
        }
      });
    });

    // ──── help.getTimezonesList ─────────────────────────────

    describe('help.getTimezonesList', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('help.getTimezonesList');

        const w = new BinaryWriter();
        w.writeInt(0x49b30240); // help.getTimezonesList
        w.writeInt(0); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        if (fixture?.response) {
          expect(ctor).toBe(getFixtureCtor(fixture));
        } else {
          expect(ctor).toBe(OFFICIAL.helpTimezonesList);
        }
      });
    });

    // ──── help.getPeerColors ────────────────────────────────

    describe('help.getPeerColors', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('help.getPeerColors');

        const w = new BinaryWriter();
        w.writeInt(0xda80f42f); // help.getPeerColors
        w.writeInt(0); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        if (fixture?.response) {
          expect(ctor).toBe(getFixtureCtor(fixture));
        } else {
          expect(ctor).toBe(OFFICIAL.helpPeerColors);
        }
      });
    });

    // ──── help.getPeerProfileColors ─────────────────────────

    describe('help.getPeerProfileColors', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('help.getPeerProfileColors');

        const w = new BinaryWriter();
        w.writeInt(0xabcfa9fd); // help.getPeerProfileColors
        w.writeInt(0); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        if (fixture?.response) {
          expect(ctor).toBe(getFixtureCtor(fixture));
        } else {
          expect(ctor).toBe(OFFICIAL.helpPeerColors);
        }
      });
    });

    // ──── langpack.getLangPack ───────────────────────────────

    describe('langpack.getLangPack', () => {
      it('should match official LangPackDifference constructor', async () => {
        const fixture = loadFixture('langpack.getLangPack');

        const w = new BinaryWriter();
        w.writeInt(0xf2f2330a); // langpack.getLangPack
        writeTlString(w, 'tdesktop');
        writeTlString(w, 'en');

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        if (fixture?.response) {
          expect(ctor).toBe(getFixtureCtor(fixture));
        } else {
          expect(ctor).toBe(OFFICIAL.langPackDifference);
        }
      });
    });

    // ──── langpack.getLanguages ─────────────────────────────

    describe('langpack.getLanguages', () => {
      it('should return Vector of LangPackLanguage', async () => {
        const w = new BinaryWriter();
        w.writeInt(0x42c6978f); // langpack.getLanguages
        writeTlString(w, 'tdesktop');

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // Returns Vector<LangPackLanguage>
        expect(ctor).toBe(OFFICIAL.vector);
      });
    });

    // ──── langpack.getStrings ───────────────────────────────

    describe('langpack.getStrings', () => {
      it('should return Vector of LangPackString', async () => {
        const w = new BinaryWriter();
        w.writeInt(0xefea3803); // langpack.getStrings
        writeTlString(w, 'tdesktop');
        writeTlString(w, 'en');
        // Vector<string> keys
        w.writeInt(OFFICIAL.vector);
        w.writeInt(1);
        writeTlString(w, 'lng_cancel');

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        expect(ctor).toBe(OFFICIAL.vector);
      });
    });

    // ──── account.updateStatus ──────────────────────────────

    describe('account.updateStatus', () => {
      it('should return Bool', async () => {
        const w = new BinaryWriter();
        w.writeInt(0x6628562c); // account.updateStatus
        w.writeInt(0); // offline = false (BoolFalse encoding as int)

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        expect([OFFICIAL.boolTrue, OFFICIAL.boolFalse]).toContain(ctor);
      });
    });

    // ──── account.getNotifySettings ─────────────────────────

    describe('account.getNotifySettings', () => {
      it('should match official PeerNotifySettings constructor', async () => {
        const fixture = loadFixture('account.getNotifySettings__pm');

        const w = new BinaryWriter();
        w.writeInt(0x12b3ad31); // account.getNotifySettings
        // InputNotifyPeer — inputNotifyPeer#b8bc5b0c peer:InputPeer
        w.writeInt(0xb8bc5b0c);
        w.writeInt(0x7da07ec9); // inputPeerSelf

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        if (fixture?.response) {
          expect(ctor).toBe(getFixtureCtor(fixture));
        } else {
          expect(ctor).toBe(OFFICIAL.peerNotifySettings);
        }
      });
    });

    // ──── account.getAuthorizations ─────────────────────────

    describe('account.getAuthorizations', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('account.getAuthorizations');

        const w = new BinaryWriter();
        w.writeInt(0xe320c158); // account.getAuthorizations

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        if (fixture?.response) {
          expect(ctor).toBe(getFixtureCtor(fixture));
        } else {
          expect(ctor).toBe(OFFICIAL.accountAuthorizations);
        }
      });
    });

    // ──── account.getGlobalPrivacySettings ──────────────────

    describe('account.getGlobalPrivacySettings', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('account.getGlobalPrivacySettings');

        const w = new BinaryWriter();
        w.writeInt(0xeb2b4cf6); // account.getGlobalPrivacySettings

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        expect(ctor).toBe(OFFICIAL.globalPrivacySettings);
      });
    });

    // ──── account.getPassword ───────────────────────────────

    describe('account.getPassword', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('account.getPassword');

        const w = new BinaryWriter();
        w.writeInt(0x548a30f5); // account.getPassword

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        if (fixture?.response) {
          expect(ctor).toBe(getFixtureCtor(fixture));
        } else {
          expect(ctor).toBe(OFFICIAL.accountPassword);
        }
      });
    });

    // ──── account.getWallPapers ─────────────────────────────

    describe('account.getWallPapers', () => {
      it('should match official constructor or NotModified', async () => {
        const fixture = loadFixture('account.getWallPapers');

        const w = new BinaryWriter();
        w.writeInt(0x07967d36); // account.getWallPapers
        w.writeLong(0n); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // Server may return WallPapers or WallPapersNotModified (0x1c199183)
        const validCtors = [OFFICIAL.accountWallPapers, 0x1c199183];
        if (fixture?.response) validCtors.push(getFixtureCtor(fixture));
        expect(validCtors).toContain(ctor);
      });
    });

    // ──── account.getContentSettings ────────────────────────

    describe('account.getContentSettings', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('account.getContentSettings');

        const w = new BinaryWriter();
        w.writeInt(0x8b9b4dae); // account.getContentSettings

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        if (fixture?.response) {
          expect(ctor).toBe(getFixtureCtor(fixture));
        } else {
          expect(ctor).toBe(OFFICIAL.accountContentSettings);
        }
      });
    });

    // ──── messages.getAvailableReactions ─────────────────────

    describe('messages.getAvailableReactions', () => {
      it('should match official constructor or NotModified', async () => {
        const fixture = loadFixture('messages.getAvailableReactions');

        const w = new BinaryWriter();
        w.writeInt(0x18dea0ac); // messages.getAvailableReactions
        w.writeInt(0); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // AvailableReactions or AvailableReactionsNotModified (0x9f071957)
        expect([OFFICIAL.messagesAvailableReactions, 0x9f071957]).toContain(ctor);
      });
    });

    // ──── messages.getAllStickers ────────────────────────────

    describe('messages.getAllStickers', () => {
      it('should match official constructor or NotModified', async () => {
        const fixture = loadFixture('messages.getAllStickers');

        const w = new BinaryWriter();
        w.writeInt(0xb8a0a1a8); // messages.getAllStickers
        w.writeLong(0n); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // AllStickers or AllStickersNotModified (0xe86602c3)
        expect([OFFICIAL.messagesAllStickers, 0xe86602c3]).toContain(ctor);
      });
    });

    // ──── messages.getStickerSet ─────────────────────────────

    describe('messages.getStickerSet', () => {
      it('should match official constructor or NotModified', async () => {
        const fixture = loadFixture('messages.getStickerSet__animated');

        const w = new BinaryWriter();
        w.writeInt(0xc8a0ec74); // messages.getStickerSet
        w.writeInt(0x028703c8); // inputStickerSetAnimatedEmoji
        w.writeInt(0); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // StickerSet, StickerSetNotModified (0xd3f924eb), or RPC error (sticker set not found)
        expect([OFFICIAL.messagesStickerSet, 0xd3f924eb, OFFICIAL.rpcError]).toContain(ctor);
      });
    });

    // ──── messages.getFeaturedStickers ───────────────────────

    describe('messages.getFeaturedStickers', () => {
      it('should match official constructor or NotModified', async () => {
        const fixture = loadFixture('messages.getFeaturedStickers');

        const w = new BinaryWriter();
        w.writeInt(0x64780b14); // messages.getFeaturedStickers
        w.writeLong(0n); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // FeaturedStickers or FeaturedStickersNotModified (0xc6dc0c66)
        expect([OFFICIAL.messagesFeaturedStickers, 0xc6dc0c66]).toContain(ctor);
      });
    });

    // ──── messages.getRecentStickers ────────────────────────

    describe('messages.getRecentStickers', () => {
      it('should match official constructor or NotModified', async () => {
        const fixture = loadFixture('messages.getRecentStickers');

        const w = new BinaryWriter();
        w.writeInt(0x9da9403b); // messages.getRecentStickers
        w.writeInt(0); // flags
        w.writeLong(0n); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // RecentStickers or RecentStickersNotModified (0x0b17f890)
        expect([OFFICIAL.messagesRecentStickers, 0x0b17f890]).toContain(ctor);
      });
    });

    // ──── messages.getSavedGifs ─────────────────────────────

    describe('messages.getSavedGifs', () => {
      it('should match official constructor or NotModified', async () => {
        const fixture = loadFixture('messages.getSavedGifs');

        const w = new BinaryWriter();
        w.writeInt(0x5cf09635); // messages.getSavedGifs
        w.writeLong(0n); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // SavedGifs or SavedGifsNotModified (0xe8025ca2)
        expect([OFFICIAL.messagesSavedGifs, 0xe8025ca2]).toContain(ctor);
      });
    });

    // ──── messages.getFavedStickers ─────────────────────────

    describe('messages.getFavedStickers', () => {
      it('should match official constructor or NotModified', async () => {
        const fixture = loadFixture('messages.getFavedStickers');

        const w = new BinaryWriter();
        w.writeInt(0x04f1aaa9); // messages.getFavedStickers
        w.writeLong(0n); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // FavedStickers or FavedStickersNotModified (0x9e8fa6d3)
        expect([OFFICIAL.messagesFavedStickers, 0x9e8fa6d3]).toContain(ctor);
      });
    });

    // ──── messages.getDefaultHistoryTTL ─────────────────────

    describe('messages.getDefaultHistoryTTL', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('messages.getDefaultHistoryTTL');

        const w = new BinaryWriter();
        w.writeInt(0x658b7188); // messages.getDefaultHistoryTTL

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        if (fixture?.response) {
          expect(ctor).toBe(getFixtureCtor(fixture));
        } else {
          expect(ctor).toBe(OFFICIAL.defaultHistoryTTL);
        }
      });
    });

    // ──── messages.getTopReactions ───────────────────────────

    describe('messages.getTopReactions', () => {
      it('should match official constructor or NotModified', async () => {
        const fixture = loadFixture('messages.getTopReactions');

        const w = new BinaryWriter();
        w.writeInt(0xbb8125ba); // messages.getTopReactions
        w.writeInt(50); // limit
        w.writeLong(0n); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // Reactions or ReactionsNotModified (0xb06fdbdf)
        expect([OFFICIAL.messagesReactions, 0xb06fdbdf]).toContain(ctor);
      });
    });

    // ──── messages.getRecentReactions ────────────────────────

    describe('messages.getRecentReactions', () => {
      it('should match official constructor or NotModified', async () => {
        const fixture = loadFixture('messages.getRecentReactions');

        const w = new BinaryWriter();
        w.writeInt(0x39461db2); // messages.getRecentReactions
        w.writeInt(50); // limit
        w.writeLong(0n); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // Reactions or ReactionsNotModified (0xb06fdbdf)
        expect([OFFICIAL.messagesReactions, 0xb06fdbdf]).toContain(ctor);
      });
    });

    // ──── messages.getAttachMenuBots ────────────────────────

    describe('messages.getAttachMenuBots', () => {
      it('should match official constructor or NotModified', async () => {
        const fixture = loadFixture('messages.getAttachMenuBots');

        const w = new BinaryWriter();
        w.writeInt(0x16fcc2cb); // messages.getAttachMenuBots
        w.writeLong(0n); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // AttachMenuBots or AttachMenuBotsNotModified (0xf1d88a5c)
        expect([OFFICIAL.attachMenuBots, 0xf1d88a5c]).toContain(ctor);
      });
    });

    // ──── messages.getEmojiKeywords ─────────────────────────

    describe('messages.getEmojiKeywords', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('messages.getEmojiKeywords');

        const w = new BinaryWriter();
        w.writeInt(0x35a0e062); // messages.getEmojiKeywords
        writeTlString(w, 'en');

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        if (fixture?.response) {
          expect(ctor).toBe(getFixtureCtor(fixture));
        } else {
          expect(ctor).toBe(OFFICIAL.emojiKeywordsDifference);
        }
      });
    });

    // ──── messages.searchGlobal ─────────────────────────────

    describe('messages.searchGlobal', () => {
      it('should return official Messages constructor', async () => {
        const fixture = loadFixture('messages.searchGlobal');

        const w = new BinaryWriter();
        w.writeInt(0x4bc6589a); // messages.searchGlobal
        w.writeInt(0); // flags
        writeTlString(w, 'test');
        w.writeInt(0xb68b7a8f); // inputMessagesFilterEmpty
        w.writeInt(0); // minDate
        w.writeInt(0); // maxDate
        w.writeInt(0); // offsetRate
        w.writeInt(0x7f3b18ea); // inputPeerEmpty
        w.writeInt(0); // offsetId
        w.writeInt(10); // limit

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        expect([OFFICIAL.messagesMessages, OFFICIAL.messagesMessagesSlice]).toContain(ctor);
      });
    });

    // ──── messages.setTyping ────────────────────────────────

    describe('messages.setTyping', () => {
      it('should return Bool', async () => {
        const w = new BinaryWriter();
        w.writeInt(0x58943ee2); // messages.setTyping
        w.writeInt(0); // flags
        w.writeInt(0x7da07ec9); // inputPeerSelf
        w.writeInt(0x16bf744e); // sendMessageTypingAction

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        expect([OFFICIAL.boolTrue, OFFICIAL.boolFalse]).toContain(ctor);
      });
    });

    // ──── messages.getWebPagePreview ─────────────────────────

    describe('messages.getWebPagePreview', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('messages.getWebPagePreview');

        const w = new BinaryWriter();
        w.writeInt(0x570d6f6f); // messages.getWebPagePreview
        w.writeInt(0); // flags
        writeTlString(w, 'https://telegram.org');

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        expect(ctor).toBe(OFFICIAL.messagesWebPagePreview);
      });
    });

    // ──── messages.getDialogUnreadMarks ─────────────────────

    describe('messages.getDialogUnreadMarks', () => {
      it('should return Vector', async () => {
        const w = new BinaryWriter();
        w.writeInt(0x21202222); // messages.getDialogUnreadMarks

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // Returns Vector<DialogPeer>
        expect(ctor).toBe(OFFICIAL.vector);
      });
    });

    // ──── messages.getMessages ──────────────────────────────

    describe('messages.getMessages', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('messages.getMessages__after_edit');

        const w = new BinaryWriter();
        w.writeInt(0x63c66506); // messages.getMessages
        w.writeInt(OFFICIAL.vector); // Vector<InputMessage>
        w.writeInt(1);
        // InputMessageID#a676de1d id:int
        w.writeInt(0xa676de1d);
        w.writeInt(1);

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        expect([OFFICIAL.messagesMessages, OFFICIAL.messagesMessagesSlice]).toContain(ctor);
      });
    });

    // ──── messages.getSavedDialogs ──────────────────────────

    describe('messages.getSavedDialogs', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('messages.getSavedDialogs');

        const w = new BinaryWriter();
        w.writeInt(0x1e91fc99); // messages.getSavedDialogs  
        w.writeInt(0); // flags
        w.writeInt(0); // offsetDate
        w.writeInt(0); // offsetId
        w.writeInt(0x7f3b18ea); // inputPeerEmpty
        w.writeInt(20); // limit
        w.writeLong(0n); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        if (fixture?.response) {
          expect(ctor).toBe(getFixtureCtor(fixture));
        } else {
          expect(ctor).toBe(OFFICIAL.messagesSavedDialogs);
        }
      });
    });

    // ──── messages.getPinnedSavedDialogs ─────────────────────

    describe('messages.getPinnedSavedDialogs', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('messages.getPinnedSavedDialogs');

        const w = new BinaryWriter();
        w.writeInt(0xd63d94e0); // messages.getPinnedSavedDialogs

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        if (fixture?.response) {
          expect(ctor).toBe(getFixtureCtor(fixture));
        } else {
          expect(ctor).toBe(OFFICIAL.messagesSavedDialogs);
        }
      });
    });

    // ──── contacts.getTopPeers ──────────────────────────────

    describe('contacts.getTopPeers', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('contacts.getTopPeers');

        const w = new BinaryWriter();
        w.writeInt(0x973478b6); // contacts.getTopPeers
        w.writeInt(1); // flags: correspondents
        w.writeInt(0); // offset
        w.writeInt(10); // limit
        w.writeLong(0n); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // TopPeers, TopPeersNotModified (0xde266ef5), or TopPeersDisabled (0xb52c939d)
        const validCtors = [OFFICIAL.contactsTopPeers, 0xde266ef5, 0xb52c939d];
        expect(validCtors).toContain(ctor);
      });
    });

    // ──── contacts.getBlocked ───────────────────────────────

    describe('contacts.getBlocked', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('contacts.getBlocked');

        const w = new BinaryWriter();
        w.writeInt(0x9a868f80); // contacts.getBlocked
        w.writeInt(0); // flags
        w.writeInt(0); // offset
        w.writeInt(10); // limit

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        if (fixture?.response) {
          expect(ctor).toBe(getFixtureCtor(fixture));
        } else {
          expect(ctor).toBe(OFFICIAL.contactsBlocked);
        }
      });
    });

    // ──── contacts.getStatuses ──────────────────────────────

    describe('contacts.getStatuses', () => {
      it('should return Vector', async () => {
        const w = new BinaryWriter();
        w.writeInt(0x3671cf); // contacts.getStatuses

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        expect(ctor).toBe(OFFICIAL.vector);
      });
    });

    // ──── messages.forwardMessages ──────────────────────────

    describe('messages.forwardMessages', () => {
      it('fixture should use official Updates constructor', () => {
        const fixture = loadFixture('messages.forwardMessages__user');
        if (!fixture?.response) return;
        expect(getFixtureCtor(fixture)).toBe(OFFICIAL.updates);
      });
    });

    // ──── messages.editMessage (fixture validation) ─────────

    describe('messages.editMessage (fixture)', () => {
      it('fixture should use official Updates constructor', () => {
        const fixture = loadFixture('messages.editMessage__user');
        if (!fixture?.response) return;
        expect(getFixtureCtor(fixture)).toBe(OFFICIAL.updates);
      });
    });

    // ──── messages.deleteMessages (fixture validation) ──────

    describe('messages.deleteMessages (fixture)', () => {
      it('fixture should use official AffectedMessages constructor', () => {
        const fixture = loadFixture('messages.deleteMessages__user');
        if (!fixture?.response) return;
        expect(getFixtureCtor(fixture)).toBe(OFFICIAL.messagesAffectedMessages);
      });
    });

    // ──── messages.readHistory (fixture validation) ─────────

    describe('messages.readHistory (fixture)', () => {
      it('fixture should use official AffectedMessages constructor', () => {
        const fixture = loadFixture('messages.readHistory__user');
        if (!fixture?.response) return;
        expect(getFixtureCtor(fixture)).toBe(OFFICIAL.messagesAffectedMessages);
      });
    });

    // ──── messages.sendMessage__reply (fixture validation) ──

    describe('messages.sendMessage reply', () => {
      it('fixture should use official UpdateShortSentMessage constructor', () => {
        const fixture = loadFixture('messages.sendMessage__reply');
        if (!fixture?.response) return;
        expect(getFixtureCtor(fixture)).toBe(OFFICIAL.updateShortSentMessage);
      });
    });

    // ──── stories ───────────────────────────────────────────

    describe('stories.getAllStories', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('stories.getAllStories');

        const w = new BinaryWriter();
        w.writeInt(0xeeb0d625); // stories.getAllStories
        w.writeInt(0); // flags

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        if (fixture?.response) {
          expect(ctor).toBe(getFixtureCtor(fixture));
        } else {
          expect(ctor).toBe(OFFICIAL.storiesAllStories);
        }
      });
    });

    // ──── stories.getPeerMaxIDs ─────────────────────────────

    describe('stories.getPeerMaxIDs', () => {
      it('should return Vector', async () => {
        const w = new BinaryWriter();
        w.writeInt(0x78499170); // stories.getPeerMaxIDs
        w.writeInt(OFFICIAL.vector); // Vector<InputPeer>
        w.writeInt(1);
        w.writeInt(0x7da07ec9); // inputPeerSelf

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        expect(ctor).toBe(OFFICIAL.vector);
      });
    });

    // ──── messages.getQuickReplies ──────────────────────────

    describe('messages.getQuickReplies', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('messages.getQuickReplies');

        const w = new BinaryWriter();
        w.writeInt(0xd483f2a8); // messages.getQuickReplies
        w.writeLong(0n); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        if (fixture?.response) {
          expect(ctor).toBe(getFixtureCtor(fixture));
        } else {
          expect(ctor).toBe(OFFICIAL.messagesQuickReplies);
        }
      });
    });

    // ──── channels.readHistory ──────────────────────────────

    describe('channels.readHistory', () => {
      it('should return Bool', async () => {
        // We don't have a channel peer, so just verify handler exists
        // and returns Bool (not RPC error for missing channel)
        const w = new BinaryWriter();
        w.writeInt(0xcc104937); // channels.readHistory
        // inputChannel#f35aec28 channel_id:long access_hash:long
        w.writeInt(0xf35aec28);
        w.writeLong(0n); // channelId = 0 (will fail but should return RPC error, not crash)
        w.writeLong(0n); // accessHash
        w.writeInt(999999); // maxId

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // Should return Bool or RPC error (not crash)
        expect([OFFICIAL.boolTrue, OFFICIAL.boolFalse, OFFICIAL.rpcError]).toContain(ctor);
      });
    });

    // ──── account.getCollectibleEmojiStatuses ─────────────────

    describe('account.getCollectibleEmojiStatuses', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('account.getCollectibleEmojiStatuses');
        if (!fixture?.response) return;

        const w = new BinaryWriter();
        w.writeInt(0x2e7b4543);
        w.writeLong(0n); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        expect(ctor).toBe(getFixtureCtor(fixture));
      });
    });

    // ──── account.getNotifyExceptions ─────────────────────────

    describe('account.getNotifyExceptions', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('account.getNotifyExceptions');
        if (!fixture?.response) return;

        const w = new BinaryWriter();
        w.writeInt(0x53577479);
        w.writeInt(0); // flags

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // Official returns Updates
        expect(ctor).toBe(getFixtureCtor(fixture));
      });
    });

    // ──── account.updateNotifySettings ────────────────────────

    describe('account.updateNotifySettings', () => {
      it('should return Bool', async () => {
        const w = new BinaryWriter();
        w.writeInt(0x84be5b93);
        // InputNotifyPeer with InputPeerSelf
        w.writeInt(0xb8bc5b0c); // inputNotifyPeer
        w.writeInt(0x7da07ec9); // inputPeerSelf
        // InputPeerNotifySettings
        w.writeInt(0xcacb6ae2); // inputPeerNotifySettings
        w.writeInt(0); // flags — all defaults

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        expect([OFFICIAL.boolTrue, OFFICIAL.boolFalse]).toContain(ctor);
      });
    });

    // ──── account.updateProfile ───────────────────────────────

    describe('account.updateProfile', () => {
      it('should return User', async () => {
        const fixture = loadFixture('account.updateProfile');
        if (!fixture?.response) return;

        const w = new BinaryWriter();
        w.writeInt(0x78515775);
        w.writeInt(1); // flags: first_name present
        writeTlString(w, 'Test');

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        expect(ctor).toBe(OFFICIAL.user);
      });
    });

    // ──── account.getContactSignUpNotification ────────────────

    describe('account.getContactSignUpNotification', () => {
      it('should return Bool', async () => {
        const w = new BinaryWriter();
        w.writeInt(0x9f07c728);

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        expect([OFFICIAL.boolTrue, OFFICIAL.boolFalse]).toContain(ctor);
      });
    });

    // ──── channels.getMessages ────────────────────────────────

    describe('channels.getMessages', () => {
      it('fixture should use official ChannelMessages constructor', () => {
        const fixture = loadFixture('channels.getMessages');
        if (!fixture?.response) return;

        expect(getFixtureCtor(fixture)).toBe(OFFICIAL.messagesChannelMessages);
      });
    });

    // ──── channels.getParticipant ─────────────────────────────

    describe('channels.getParticipant', () => {
      it('fixture should use official constructor', () => {
        const fixture = loadFixture('channels.getParticipant__self');
        if (!fixture?.response) return;

        expect(getFixtureCtor(fixture)).toBe(OFFICIAL.channelsChannelParticipant);
      });
    });

    // ──── channels.inviteToChannel ────────────────────────────

    describe('channels.inviteToChannel', () => {
      it('fixture should use official InvitedUsers constructor', () => {
        const fixture = loadFixture('channels.inviteToChannel');
        if (!fixture?.response) return;

        expect(getFixtureCtor(fixture)).toBe(OFFICIAL.messagesInvitedUsers);
      });
    });

    // ──── channels.deleteChannel ──────────────────────────────

    describe('channels.deleteChannel', () => {
      it('fixture should use official Updates constructor', () => {
        const fixture = loadFixture('channels.deleteChannel');
        if (!fixture?.response) return;

        expect(getFixtureCtor(fixture)).toBe(OFFICIAL.updates);
      });
    });

    // ──── help.getPromoData ───────────────────────────────────

    describe('help.getPromoData', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('help.getPromoData');
        if (!fixture?.response) return;

        const w = new BinaryWriter();
        w.writeInt(0xc0977421);

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        expect(ctor).toBe(getFixtureCtor(fixture));
      });
    });

    // ──── help.getTermsOfServiceUpdate ────────────────────────

    describe('help.getTermsOfServiceUpdate', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('help.getTermsOfServiceUpdate');
        if (!fixture?.response) return;

        const w = new BinaryWriter();
        w.writeInt(0x2ca51fd1);

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // Could be TermsOfServiceUpdate or TermsOfServiceUpdateEmpty
        expect(ctor).toBe(getFixtureCtor(fixture));
      });
    });

    // ──── langpack.getDifference ──────────────────────────────

    describe('langpack.getDifference', () => {
      it('should match official LangPackDifference constructor', async () => {
        const fixture = loadFixture('langpack.getDifference');
        if (!fixture?.response) return;

        const w = new BinaryWriter();
        w.writeInt(0xcd984aa5);
        writeTlString(w, 'tdesktop');
        writeTlString(w, 'en');
        w.writeInt(0); // fromVersion

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        expect(ctor).toBe(OFFICIAL.langPackDifference);
      });
    });

    // ──── langpack.getLanguage ────────────────────────────────

    describe('langpack.getLanguage', () => {
      it('should match official LangPackLanguage constructor', async () => {
        const fixture = loadFixture('langpack.getLanguage');
        if (!fixture?.response) return;

        const w = new BinaryWriter();
        w.writeInt(0x6a596502);
        writeTlString(w, 'tdesktop');
        writeTlString(w, 'en');

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        expect(ctor).toBe(OFFICIAL.langPackLanguage);
      });
    });

    // ──── messages.getAvailableEffects ────────────────────────

    describe('messages.getAvailableEffects', () => {
      it('should match official constructor or NotModified', async () => {
        const fixture = loadFixture('messages.getAvailableEffects');
        if (!fixture?.response) return;

        const w = new BinaryWriter();
        w.writeInt(0xdea20a39);
        w.writeInt(0); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        expect(ctor).toBe(getFixtureCtor(fixture));
      });
    });

    // ──── messages.getFeaturedEmojiStickers ────────────────────

    describe('messages.getFeaturedEmojiStickers', () => {
      it('should match official constructor or NotModified', async () => {
        const fixture = loadFixture('messages.getFeaturedEmojiStickers');
        if (!fixture?.response) return;

        const w = new BinaryWriter();
        w.writeInt(0x0ecf6736);
        w.writeLong(0n); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // FeaturedStickers or FeaturedStickersNotModified (0xc6dc0c66)
        expect([OFFICIAL.messagesFeaturedStickers, 0xc6dc0c66]).toContain(ctor);
      });
    });

    // ──── messages.getEmojiKeywordsDifference ─────────────────

    describe('messages.getEmojiKeywordsDifference', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('messages.getEmojiKeywordsDifference');
        if (!fixture?.response) return;

        const w = new BinaryWriter();
        w.writeInt(0x1508b6af);
        writeTlString(w, 'en');
        w.writeInt(0); // fromVersion

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        expect(ctor).toBe(OFFICIAL.emojiKeywordsDifference);
      });
    });

    // ──── messages.getEmojiURL ────────────────────────────────

    describe('messages.getEmojiURL', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('messages.getEmojiURL');
        if (!fixture?.response) return;

        const w = new BinaryWriter();
        w.writeInt(0xd5b10c26);
        writeTlString(w, 'en');

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        expect(ctor).toBe(OFFICIAL.emojiURL);
      });
    });

    // ──── messages.getStickers ────────────────────────────────

    describe('messages.getStickers', () => {
      it('should match official constructor or NotModified', async () => {
        const fixture = loadFixture('messages.getStickers');
        if (!fixture?.response) return;

        const w = new BinaryWriter();
        w.writeInt(0xd5a5d3a1);
        writeTlString(w, '😀');
        w.writeLong(0n); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // Stickers or StickersNotModified (0xf1749a22)
        expect([OFFICIAL.messagesStickers, 0xf1749a22]).toContain(ctor);
      });
    });

    // ──── messages.getPaidReactionPrivacy ──────────────────────

    describe('messages.getPaidReactionPrivacy', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('messages.getPaidReactionPrivacy');
        if (!fixture?.response) return;

        const w = new BinaryWriter();
        w.writeInt(0x472455aa);

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        expect(ctor).toBe(getFixtureCtor(fixture));
      });
    });

    // ──── messages.getScheduledHistory ─────────────────────────

    describe('messages.getScheduledHistory', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('messages.getScheduledHistory');
        if (!fixture?.response) return;

        const w = new BinaryWriter();
        w.writeInt(0xf516760b);
        w.writeInt(0x7da07ec9); // inputPeerSelf
        w.writeLong(0n); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        expect(ctor).toBe(OFFICIAL.messagesScheduledMessages);
      });
    });

    // ──── messages.getSavedHistory ─────────────────────────────

    describe('messages.getSavedHistory', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('messages.getSavedHistory');
        if (!fixture?.response) return;

        const w = new BinaryWriter();
        w.writeInt(0x998ab009);
        w.writeInt(0x7da07ec9); // inputPeerSelf
        w.writeInt(0); w.writeInt(0); w.writeInt(0);
        w.writeInt(20); w.writeInt(0); w.writeInt(0);
        w.writeLong(0n);

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        expect(ctor).toBe(OFFICIAL.messagesMessages);
      });
    });

    // ──── messages.getSponsoredMessages ────────────────────────

    describe('messages.getSponsoredMessages', () => {
      it('fixture should use official constructor', () => {
        const fixture = loadFixture('messages.getSponsoredMessages');
        if (!fixture?.response) return;

        expect(getFixtureCtor(fixture)).toBe(OFFICIAL.messagesSponsoredMessagesEmpty);
      });
    });

    // ──── messages.getExportedChatInvites ──────────────────────

    describe('messages.getExportedChatInvites', () => {
      it('fixture should use official constructor', () => {
        const fixture = loadFixture('messages.getExportedChatInvites');
        if (!fixture?.response) return;

        expect(getFixtureCtor(fixture)).toBe(OFFICIAL.messagesExportedChatInvites);
      });
    });

    // ──── messages.getChatInviteImporters ──────────────────────

    describe('messages.getChatInviteImporters', () => {
      it('fixture should use official constructor', () => {
        const fixture = loadFixture('messages.getChatInviteImporters');
        if (!fixture?.response) return;

        expect(getFixtureCtor(fixture)).toBe(OFFICIAL.messagesChatInviteImporters);
      });
    });

    // ──── messages.sendReaction (fixture) ──────────────────────

    describe('messages.sendReaction', () => {
      it('fixture should use official Updates constructor', () => {
        const fixture = loadFixture('messages.sendReaction');
        if (!fixture?.response) return;

        expect(getFixtureCtor(fixture)).toBe(OFFICIAL.updates);
      });
    });

    // ──── messages.toggleDialogPin (fixture) ───────────────────

    describe('messages.toggleDialogPin', () => {
      it('fixture should return Bool', () => {
        const fixture = loadFixture('messages.toggleDialogPin__pin');
        if (!fixture?.response) return;

        // response is true/false boolean
        expect(typeof fixture.response === 'boolean').toBe(true);
      });
    });

    // ──── messages.reorderPinnedDialogs (fixture) ──────────────

    describe('messages.reorderPinnedDialogs', () => {
      it('fixture should return Bool', () => {
        const fixture = loadFixture('messages.reorderPinnedDialogs');
        if (!fixture?.response) return;

        expect(typeof fixture.response === 'boolean').toBe(true);
      });
    });

    // ──── messages.getAllDrafts ────────────────────────────────

    describe('messages.getAllDrafts', () => {
      it('fixture should use official Updates constructor', () => {
        const fixture = loadFixture('messages.getAllDrafts');
        if (!fixture?.response) return;

        expect(getFixtureCtor(fixture)).toBe(OFFICIAL.updates);
      });
    });

    // ──── messages.getCustomEmojiDocuments ─────────────────────

    describe('messages.getCustomEmojiDocuments', () => {
      it('fixture should return Vector of Document', () => {
        const fixture = loadFixture('messages.getCustomEmojiDocuments');
        if (!fixture?.response) return;

        // Response is a vector (array) of Document objects
        expect(Array.isArray(fixture.response)).toBe(true);
      });
    });

    // ──── upload.saveFilePart ──────────────────────────────────

    describe('upload.saveFilePart', () => {
      it('fixture should return Bool', () => {
        const fixture = loadFixture('upload.saveFilePart');
        if (!fixture?.response) return;

        expect(typeof fixture.response === 'boolean').toBe(true);
      });
    });

    // ──── payments.getStarGifts ───────────────────────────────

    describe('payments.getStarGifts', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('payments.getStarGifts');
        if (!fixture?.response) return;

        const w = new BinaryWriter();
        w.writeInt(0xc4563590);
        w.writeInt(0); // hash

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        expect(ctor).toBe(OFFICIAL.paymentsStarGifts);
      });
    });

    // ──── payments.getSavedStarGifts ──────────────────────────

    describe('payments.getSavedStarGifts', () => {
      it('should match official constructor', async () => {
        const fixture = loadFixture('payments.getSavedStarGifts');
        if (!fixture?.response) return;

        const w = new BinaryWriter();
        w.writeInt(0xa319e569);
        w.writeInt(0); // flags
        w.writeInt(0x7da07ec9); // inputPeerSelf
        writeTlString(w, ''); // offset
        w.writeInt(20); // limit

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        expect(ctor).toBe(getFixtureCtor(fixture));
      });
    });

    // ──── payments.getStarsTopupOptions ───────────────────────

    describe('payments.getStarsTopupOptions', () => {
      it('should return Vector', async () => {
        const w = new BinaryWriter();
        w.writeInt(0xc00ec7d3);

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // Returns Vector<StarsTopupOption>
        expect(ctor).toBe(OFFICIAL.vector);
      });
    });

    // ──── messages.sendMedia (fixture) ────────────────────────

    describe('messages.sendMedia (fixture)', () => {
      it('fixture should use official Updates constructor', () => {
        const fixture = loadFixture('messages.sendMedia__photo');
        if (!fixture?.response) return;

        expect(getFixtureCtor(fixture)).toBe(OFFICIAL.updates);
      });
    });

    // ──── messages.getFullChat ────────────────────────────────

    describe('messages.getFullChat', () => {
      it('fixture should use official constructor', () => {
        const fixture = loadFixture('messages.getFullChat');
        if (!fixture?.response) return;

        expect(getFixtureCtor(fixture)).toBe(OFFICIAL.messagesChatFull);
      });

      it('should return messages.ChatFull from server', async () => {
        // messages.getFullChat needs a valid chatId; use 0 which returns RPC error
        const w = new BinaryWriter();
        w.writeInt(0xaeb00b34);
        w.writeLong(0n); // chatId = 0

        const resp = await authedClient.sendRequest(w.getBytes());
        const ctor = getResponseCtor(resp);

        // Should not crash — either ChatFull or RPC error
        expect([OFFICIAL.messagesChatFull, OFFICIAL.rpcError]).toContain(ctor);
      });
    });

    // ──── messages.sendMessage__chat (fixture) ────────────────

    describe('messages.sendMessage__chat (fixture)', () => {
      it('fixture should use official constructor', () => {
        const fixture = loadFixture('messages.sendMessage__chat');
        if (!fixture?.response) return;

        // Group messages return Updates
        expect([OFFICIAL.updates, OFFICIAL.updateShortSentMessage]).toContain(getFixtureCtor(fixture));
      });
    });

    // ──── messages.sendMessage__fwd_source (fixture) ──────────

    describe('messages.sendMessage__fwd_source (fixture)', () => {
      it('fixture should use official constructor', () => {
        const fixture = loadFixture('messages.sendMessage__fwd_source');
        if (!fixture?.response) return;

        expect(OFFICIAL_SEND_MESSAGE_CTORS).toContain(getFixtureCtor(fixture));
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 4. FIXTURE STRUCTURE VALIDATION
  //    Verifies all captured fixtures have proper TL structure
  // ═══════════════════════════════════════════════════════════════

  describe('Fixture integrity', () => {
    const fixtureNames = listFixtures();

    for (const name of fixtureNames) {
      it(`"${name}" has valid structure`, () => {
        const fixture = loadFixture(name);
        expect(fixture).toBeDefined();
        expect(fixture!.method).toBeDefined();
        expect(fixture!.capturedAt || fixture!.error).toBeDefined();

        if (fixture!.response) {
          const hasCtorOrClass = fixture!.response.__constructorId || fixture!.response.__className;
          const isArray = Array.isArray(fixture!.response);
          const isPrimitive = typeof fixture!.response === 'boolean' || typeof fixture!.response === 'number';
          expect(hasCtorOrClass || isArray || isPrimitive).toBeTruthy();
        }
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // 5. CONSTRUCTOR ID CONSISTENCY
  //    Ensures fixtures (captured from official Telegram, Layer 198)
  //    match the expected official constructors for that layer.
  //    NOTE: These differ from OFFICIAL (web client) for some types.
  // ═══════════════════════════════════════════════════════════════

  // Fixture constructors captured from official Telegram at Layer 198
  // (may differ from OFFICIAL which targets web client Layer 223)
  const FIXTURE_CTORS = {
    ...OFFICIAL,
    messagesMessages:           0x8c718e87,
    messagesMessagesSlice:      0x3a54685e,
    messagesWebPagePreview:     0xb53e8b21,
    globalPrivacySettings:      0x734c4ccb,
    paymentsStarGifts:          0x901689ea,
    messagesScheduledMessages:  0x8c718e87,
    user:                       0x4b46c37e,
    updateShort:                0x11f1331c,
  };

  describe('Official constructor ID verification', () => {
    const expectedCtors: Record<string, number> = {
      // Core
      'help.getConfig':                   FIXTURE_CTORS.config,
      'updates.getState':                 FIXTURE_CTORS.updatesState,

      // Contacts
      'contacts.search__test':            FIXTURE_CTORS.contactsFound,
      'contacts.resolveUsername__target':  FIXTURE_CTORS.contactsResolvedPeer,
      'contacts.resolveUsername__telegram': FIXTURE_CTORS.contactsResolvedPeer,
      'contacts.getContacts':             FIXTURE_CTORS.contactsContacts,
      'contacts.getTopPeers':             FIXTURE_CTORS.contactsTopPeers,
      'contacts.getBlocked':              FIXTURE_CTORS.contactsBlocked,

      // Messages
      'messages.getDialogs':              FIXTURE_CTORS.messagesDialogs,
      'messages.getDialogFilters':        FIXTURE_CTORS.messagesDialogFilters,
      'messages.getPinnedDialogs':        FIXTURE_CTORS.messagesPeerDialogs,
      'messages.sendMessage__user':       FIXTURE_CTORS.updateShortSentMessage,
      'messages.sendMessage__base':       FIXTURE_CTORS.updateShortSentMessage,
      'messages.sendMessage__reply':      FIXTURE_CTORS.updateShortSentMessage,
      'messages.sendMessage__channel':    FIXTURE_CTORS.updates,
      'messages.editMessage__user':       FIXTURE_CTORS.updates,
      'messages.deleteMessages__user':    FIXTURE_CTORS.messagesAffectedMessages,
      'messages.readHistory__user':       FIXTURE_CTORS.messagesAffectedMessages,
      'messages.forwardMessages__user':   FIXTURE_CTORS.updates,
      'messages.getMessages__after_edit': FIXTURE_CTORS.messagesMessages,
      'messages.searchGlobal':            FIXTURE_CTORS.messagesMessages,
      'messages.getWebPagePreview':       FIXTURE_CTORS.messagesWebPagePreview,
      'messages.createChat':              FIXTURE_CTORS.messagesInvitedUsers,
      'messages.getSavedDialogs':         FIXTURE_CTORS.messagesSavedDialogs,
      'messages.getPinnedSavedDialogs':   FIXTURE_CTORS.messagesSavedDialogs,
      'messages.getQuickReplies':         FIXTURE_CTORS.messagesQuickReplies,
      'messages.getDefaultHistoryTTL':    FIXTURE_CTORS.defaultHistoryTTL,

      // Stickers & reactions
      'messages.getAvailableReactions':   FIXTURE_CTORS.messagesAvailableReactions,
      'messages.getAllStickers':           FIXTURE_CTORS.messagesAllStickers,
      'messages.getEmojiStickers':        FIXTURE_CTORS.messagesAllStickers,
      'messages.getFeaturedStickers':     FIXTURE_CTORS.messagesFeaturedStickers,
      'messages.getRecentStickers':       FIXTURE_CTORS.messagesRecentStickers,
      'messages.getSavedGifs':            FIXTURE_CTORS.messagesSavedGifs,
      'messages.getFavedStickers':        FIXTURE_CTORS.messagesFavedStickers,
      'messages.getTopReactions':         FIXTURE_CTORS.messagesReactions,
      'messages.getRecentReactions':      FIXTURE_CTORS.messagesReactions,
      'messages.getDefaultTagReactions':  FIXTURE_CTORS.messagesDefaultTagReactions,
      'messages.getStickerSet__animated': FIXTURE_CTORS.messagesStickerSet,
      'messages.getAttachMenuBots':       FIXTURE_CTORS.attachMenuBots,
      'messages.getEmojiKeywords':        FIXTURE_CTORS.emojiKeywordsDifference,

      // Channels
      'channels.createChannel':           FIXTURE_CTORS.updates,
      'channels.getFullChannel':          FIXTURE_CTORS.messagesChatFull,
      'channels.getParticipants':         FIXTURE_CTORS.channelParticipants,

      // Users
      'users.getFullUser__self':          FIXTURE_CTORS.usersUserFull,

      // Account
      'account.getAuthorizations':        FIXTURE_CTORS.accountAuthorizations,
      'account.getPassword':              FIXTURE_CTORS.accountPassword,
      'account.getWallPapers':            FIXTURE_CTORS.accountWallPapers,
      'account.getContentSettings':       FIXTURE_CTORS.accountContentSettings,
      'account.getGlobalPrivacySettings': FIXTURE_CTORS.globalPrivacySettings,
      'account.getNotifySettings__pm':    FIXTURE_CTORS.peerNotifySettings,
      'account.getPrivacy__statusTimestamp': FIXTURE_CTORS.accountPrivacyRules,

      // Help
      'help.getAppConfig':                FIXTURE_CTORS.helpAppConfig,
      'help.getCountriesList':            FIXTURE_CTORS.helpCountriesList,
      'help.getTimezonesList':            FIXTURE_CTORS.helpTimezonesList,
      'help.getNearestDc':                FIXTURE_CTORS.nearestDc,
      'help.getPeerColors':               FIXTURE_CTORS.helpPeerColors,
      'help.getPeerProfileColors':        FIXTURE_CTORS.helpPeerColors,

      // Langpack
      'langpack.getLangPack':             FIXTURE_CTORS.langPackDifference,
      'langpack.getDifference':           FIXTURE_CTORS.langPackDifference,
      'langpack.getLanguage':             FIXTURE_CTORS.langPackLanguage,

      // Payments
      'payments.getStarsStatus':          FIXTURE_CTORS.paymentsStarsStatus,
      'payments.getStarGifts':            FIXTURE_CTORS.paymentsStarGifts,
      'payments.getSavedStarGifts':       FIXTURE_CTORS.paymentsSavedStarGifts,

      // Stories
      'stories.getAllStories':            FIXTURE_CTORS.storiesAllStories,

      // New messages
      'messages.getAvailableEffects':     FIXTURE_CTORS.messagesAvailableEffects,
      'messages.getFeaturedEmojiStickers': FIXTURE_CTORS.messagesFeaturedStickers,
      'messages.getEmojiKeywordsDifference': FIXTURE_CTORS.emojiKeywordsDifference,
      'messages.getEmojiURL':             FIXTURE_CTORS.emojiURL,
      'messages.getStickers':             FIXTURE_CTORS.messagesStickers,
      'messages.getSponsoredMessages':    FIXTURE_CTORS.messagesSponsoredMessagesEmpty,
      'messages.getExportedChatInvites':  FIXTURE_CTORS.messagesExportedChatInvites,
      'messages.getChatInviteImporters':  FIXTURE_CTORS.messagesChatInviteImporters,
      'messages.getSavedHistory':         FIXTURE_CTORS.messagesMessages,
      'messages.getScheduledHistory':     FIXTURE_CTORS.messagesScheduledMessages,
      'messages.sendReaction':            FIXTURE_CTORS.updates,
      'messages.getAllDrafts':            FIXTURE_CTORS.updates,

      // New channels
      'channels.getMessages':             FIXTURE_CTORS.messagesChannelMessages,
      'channels.getParticipant__self':    FIXTURE_CTORS.channelsChannelParticipant,
      'channels.inviteToChannel':         FIXTURE_CTORS.messagesInvitedUsers,
      'channels.deleteChannel':           FIXTURE_CTORS.updates,

      // New account
      'account.getCollectibleEmojiStatuses': FIXTURE_CTORS.accountEmojiStatuses,
      'account.getNotifyExceptions':      FIXTURE_CTORS.updates,
      'account.updateProfile':            FIXTURE_CTORS.user,
      'messages.getPaidReactionPrivacy':   FIXTURE_CTORS.updates,

      // New help
      'help.getPromoData':                FIXTURE_CTORS.helpPromoDataEmpty,
      'help.getTermsOfServiceUpdate':     FIXTURE_CTORS.helpTermsOfServiceUpdateEmpty,
    };

    for (const [method, expectedCtor] of Object.entries(expectedCtors)) {
      it(`${method} → 0x${expectedCtor.toString(16).padStart(8, '0')}`, () => {
        const fixture = loadFixture(method);
        if (!fixture?.response) return;
        expect(getFixtureCtor(fixture)).toBe(expectedCtor);
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // 6. DEEP STRUCTURE COMPARISON
  //    Compare field names/types between fixtures and server responses
  // ═══════════════════════════════════════════════════════════════

  describe('Deep structure comparison', () => {
    it('help.getConfig: response structure matches fixture', async () => {
      const fixture = loadFixture('help.getConfig');
      if (!fixture?.response) return;

      const req = Buffer.alloc(4);
      req.writeUInt32LE(0xc4f9186b, 0);
      const resp = await client.sendRequest(req);
      const ctor = getResponseCtor(resp);

      expect(ctor).toBe(getFixtureCtor(fixture));
    });

    it('updates.getState: all 5 fields present', () => {
      const fixture = loadFixture('updates.getState');
      if (!fixture?.response) return;

      const officialKeys = Object.keys(fixture.response).filter(k => !k.startsWith('__') && k !== 'originalArgs' && k !== 'className' && k !== 'classType' && k !== 'SUBCLASS_OF_ID');
      expect(officialKeys).toContain('pts');
      expect(officialKeys).toContain('qts');
      expect(officialKeys).toContain('date');
      expect(officialKeys).toContain('seq');
      expect(officialKeys).toContain('unreadCount');
    });

    it('messages.getDialogs: has dialogs/messages/users/chats arrays', () => {
      const fixture = loadFixture('messages.getDialogs');
      if (!fixture?.response) return;

      expect(fixture.response.dialogs).toBeDefined();
      expect(Array.isArray(fixture.response.dialogs)).toBe(true);
      expect(fixture.response.messages).toBeDefined();
      expect(fixture.response.users).toBeDefined();
      expect(fixture.response.chats).toBeDefined();
    });

    it('messages.sendMessage__user: has id/pts/date fields', () => {
      const fixture = loadFixture('messages.sendMessage__user');
      if (!fixture?.response) return;

      expect(fixture.response.__className).toBe('UpdateShortSentMessage');
      expect(fixture.response.id).toBeDefined();
      expect(fixture.response.pts).toBeDefined();
      expect(fixture.response.ptsCount).toBeDefined();
      expect(fixture.response.date).toBeDefined();
    });

    it('messages.sendMessage__channel: has updates/users/chats arrays', () => {
      const fixture = loadFixture('messages.sendMessage__channel');
      if (!fixture?.response) return;

      expect(fixture.response.__className).toBe('Updates');
      expect(fixture.response.updates).toBeDefined();
      expect(Array.isArray(fixture.response.updates)).toBe(true);
      expect(fixture.response.users).toBeDefined();
      expect(fixture.response.chats).toBeDefined();
    });

    it('messages.sendMessage__reply: has id/pts/date (same as P2P)', () => {
      const fixture = loadFixture('messages.sendMessage__reply');
      if (!fixture?.response) return;

      expect(fixture.response.__className).toBe('UpdateShortSentMessage');
      expect(fixture.response.id).toBeDefined();
      expect(fixture.response.pts).toBeDefined();
      expect(fixture.response.date).toBeDefined();
    });

    it('messages.editMessage__user: has updates/users/chats', () => {
      const fixture = loadFixture('messages.editMessage__user');
      if (!fixture?.response) return;

      expect(fixture.response.__className).toBe('Updates');
      expect(fixture.response.updates).toBeDefined();
      expect(fixture.response.users).toBeDefined();
      expect(fixture.response.chats).toBeDefined();
    });

    it('messages.deleteMessages__user: has pts/ptsCount', () => {
      const fixture = loadFixture('messages.deleteMessages__user');
      if (!fixture?.response) return;

      expect(fixture.response.__className).toBe('messages.AffectedMessages');
      expect(fixture.response.pts).toBeDefined();
      expect(fixture.response.ptsCount).toBeDefined();
    });

    it('messages.readHistory__user: has pts/ptsCount', () => {
      const fixture = loadFixture('messages.readHistory__user');
      if (!fixture?.response) return;

      expect(fixture.response.__className).toBe('messages.AffectedMessages');
      expect(fixture.response.pts).toBeDefined();
      expect(fixture.response.ptsCount).toBeDefined();
    });

    it('messages.forwardMessages__user: has updates/users/chats', () => {
      const fixture = loadFixture('messages.forwardMessages__user');
      if (!fixture?.response) return;

      expect(fixture.response.__className).toBe('Updates');
      expect(fixture.response.updates).toBeDefined();
      expect(fixture.response.users).toBeDefined();
      expect(fixture.response.chats).toBeDefined();
    });

    it('contacts.search: has myResults/results/users/chats', () => {
      const fixture = loadFixture('contacts.search__test');
      if (!fixture?.response) return;

      expect(fixture.response.myResults).toBeDefined();
      expect(fixture.response.results).toBeDefined();
      expect(fixture.response.users).toBeDefined();
      expect(fixture.response.chats).toBeDefined();
    });

    it('contacts.getContacts: has contacts/savedCount/users', () => {
      const fixture = loadFixture('contacts.getContacts');
      if (!fixture?.response) return;

      expect(fixture.response.contacts).toBeDefined();
      expect(fixture.response.savedCount).toBeDefined();
      expect(fixture.response.users).toBeDefined();
    });

    it('contacts.getBlocked: has blocked/chats/users', () => {
      const fixture = loadFixture('contacts.getBlocked');
      if (!fixture?.response) return;

      expect(fixture.response.blocked).toBeDefined();
      expect(fixture.response.chats).toBeDefined();
      expect(fixture.response.users).toBeDefined();
    });

    it('channels.getFullChannel: has fullChat/chats/users', () => {
      const fixture = loadFixture('channels.getFullChannel');
      if (!fixture?.response) return;

      expect(fixture.response.fullChat).toBeDefined();
      expect(fixture.response.chats).toBeDefined();
      expect(fixture.response.users).toBeDefined();
    });

    it('channels.getParticipants: has count/participants/users/chats', () => {
      const fixture = loadFixture('channels.getParticipants');
      if (!fixture?.response) return;

      expect(fixture.response.count).toBeDefined();
      expect(fixture.response.participants).toBeDefined();
      expect(fixture.response.users).toBeDefined();
      expect(fixture.response.chats).toBeDefined();
    });

    it('users.getFullUser__self: has fullUser/users/chats', () => {
      const fixture = loadFixture('users.getFullUser__self');
      if (!fixture?.response) return;

      expect(fixture.response.fullUser).toBeDefined();
      expect(fixture.response.users).toBeDefined();
      expect(fixture.response.chats).toBeDefined();
    });

    it('messages.getHistory (MessagesSlice): has count/messages/users/chats', () => {
      const fixture = loadFixture('messages.getHistory__after__user_338781882');
      if (!fixture?.response) return;

      expect(fixture.response.__className).toBe('messages.MessagesSlice');
      expect(fixture.response.count).toBeDefined();
      expect(fixture.response.messages).toBeDefined();
      expect(fixture.response.users).toBeDefined();
      expect(fixture.response.chats).toBeDefined();
    });

    it('messages.getHistory (Messages): has messages/users/chats', () => {
      const fixture = loadFixture('messages.getHistory__chat_5095384911');
      if (!fixture?.response) return;

      expect(fixture.response.__className).toBe('messages.Messages');
      expect(fixture.response.messages).toBeDefined();
      expect(fixture.response.users).toBeDefined();
      expect(fixture.response.chats).toBeDefined();
    });

    it('messages.getHistory (ChannelMessages): has pts/count/messages', () => {
      const fixture = loadFixture('messages.getHistory__channel');
      if (!fixture?.response) return;

      expect(fixture.response.__className).toBe('messages.ChannelMessages');
      expect(fixture.response.pts).toBeDefined();
      expect(fixture.response.count).toBeDefined();
      expect(fixture.response.messages).toBeDefined();
      expect(fixture.response.users).toBeDefined();
      expect(fixture.response.chats).toBeDefined();
    });

    it('messages.getMessages__after_edit: has messages/users/chats', () => {
      const fixture = loadFixture('messages.getMessages__after_edit');
      if (!fixture?.response) return;

      expect(fixture.response.messages).toBeDefined();
      expect(fixture.response.users).toBeDefined();
      expect(fixture.response.chats).toBeDefined();
    });

    it('account.getAuthorizations: has authorizationTTLDays/authorizations', () => {
      const fixture = loadFixture('account.getAuthorizations');
      if (!fixture?.response) return;

      expect(fixture.response.authorizationTtlDays).toBeDefined();
      expect(fixture.response.authorizations).toBeDefined();
      expect(Array.isArray(fixture.response.authorizations)).toBe(true);
    });

    it('account.getPassword: has hasRecovery/hasPassword flags', () => {
      const fixture = loadFixture('account.getPassword');
      if (!fixture?.response) return;

      expect(fixture.response.newAlgo).toBeDefined();
      expect(fixture.response.newSecureAlgo).toBeDefined();
    });

    it('help.getAppConfig: has config object', () => {
      const fixture = loadFixture('help.getAppConfig');
      if (!fixture?.response) return;

      expect(fixture.response.hash).toBeDefined();
      expect(fixture.response.config).toBeDefined();
    });

    it('help.getCountriesList: has countries array', () => {
      const fixture = loadFixture('help.getCountriesList');
      if (!fixture?.response) return;

      expect(fixture.response.countries).toBeDefined();
      expect(Array.isArray(fixture.response.countries)).toBe(true);
      expect(fixture.response.hash).toBeDefined();
    });

    it('help.getTimezonesList: has timezones array', () => {
      const fixture = loadFixture('help.getTimezonesList');
      if (!fixture?.response) return;

      expect(fixture.response.timezones).toBeDefined();
      expect(Array.isArray(fixture.response.timezones)).toBe(true);
    });

    it('langpack.getLangPack: has langCode/strings', () => {
      const fixture = loadFixture('langpack.getLangPack');
      if (!fixture?.response) return;

      expect(fixture.response.langCode).toBeDefined();
      expect(fixture.response.strings).toBeDefined();
      expect(Array.isArray(fixture.response.strings)).toBe(true);
      expect(fixture.response.version).toBeDefined();
    });

    it('messages.getAvailableReactions: has reactions array', () => {
      const fixture = loadFixture('messages.getAvailableReactions');
      if (!fixture?.response) return;

      expect(fixture.response.hash).toBeDefined();
      expect(fixture.response.reactions).toBeDefined();
      expect(Array.isArray(fixture.response.reactions)).toBe(true);
    });

    it('messages.searchGlobal: has messages/users/chats', () => {
      const fixture = loadFixture('messages.searchGlobal');
      if (!fixture?.response) return;

      expect(fixture.response.messages).toBeDefined();
      expect(fixture.response.users).toBeDefined();
      expect(fixture.response.chats).toBeDefined();
    });

    it('messages.getSavedDialogs: has dialogs/messages/users/chats', () => {
      const fixture = loadFixture('messages.getSavedDialogs');
      if (!fixture?.response) return;

      expect(fixture.response.dialogs).toBeDefined();
      expect(fixture.response.messages).toBeDefined();
      expect(fixture.response.users).toBeDefined();
      expect(fixture.response.chats).toBeDefined();
    });

    it('messages.getStickerSet: has set/packs/documents', () => {
      const fixture = loadFixture('messages.getStickerSet__animated');
      if (!fixture?.response) return;

      expect(fixture.response.set).toBeDefined();
      expect(fixture.response.packs).toBeDefined();
      expect(fixture.response.documents).toBeDefined();
    });

    it('stories.getAllStories: has peerStories/users/chats', () => {
      const fixture = loadFixture('stories.getAllStories');
      if (!fixture?.response) return;

      expect(fixture.response.peerStories).toBeDefined();
      expect(fixture.response.users).toBeDefined();
      expect(fixture.response.chats).toBeDefined();
    });

    it('payments.getStarsStatus: has balance', () => {
      const fixture = loadFixture('payments.getStarsStatus');
      if (!fixture?.response) return;

      expect(fixture.response.balance).toBeDefined();
    });

    it('updates.getDifference: has newMessages/otherUpdates/state or chats/users', () => {
      const fixture = loadFixture('updates.getDifference');
      if (!fixture?.response) return;

      // Could be Difference, DifferenceSlice, DifferenceEmpty
      const className = fixture.response.__className;
      if (className === 'updates.Difference' || className === 'updates.DifferenceSlice') {
        expect(fixture.response.newMessages).toBeDefined();
        expect(fixture.response.otherUpdates).toBeDefined();
        expect(fixture.response.users).toBeDefined();
        expect(fixture.response.chats).toBeDefined();
      }
    });

    // ──── New deep structure tests ───────────────────────────

    it('langpack.getDifference: has langCode/fromVersion/strings', () => {
      const fixture = loadFixture('langpack.getDifference');
      if (!fixture?.response) return;

      expect(fixture.response.langCode).toBeDefined();
      expect(fixture.response.fromVersion).toBeDefined();
      expect(fixture.response.strings).toBeDefined();
    });

    it('langpack.getLanguage: has name/nativeName/langCode', () => {
      const fixture = loadFixture('langpack.getLanguage');
      if (!fixture?.response) return;

      expect(fixture.response.name).toBeDefined();
      expect(fixture.response.nativeName).toBeDefined();
      expect(fixture.response.langCode).toBeDefined();
    });

    it('account.getCollectibleEmojiStatuses: has statuses array', () => {
      const fixture = loadFixture('account.getCollectibleEmojiStatuses');
      if (!fixture?.response) return;

      expect(fixture.response.statuses).toBeDefined();
    });

    it('account.getNotifyExceptions: has updates array', () => {
      const fixture = loadFixture('account.getNotifyExceptions');
      if (!fixture?.response) return;

      expect(fixture.response.updates).toBeDefined();
      expect(fixture.response.users).toBeDefined();
      expect(fixture.response.chats).toBeDefined();
    });

    it('account.updateProfile: returns User with id/firstName', () => {
      const fixture = loadFixture('account.updateProfile');
      if (!fixture?.response) return;

      expect(fixture.response.id).toBeDefined();
      expect(fixture.response.firstName).toBeDefined();
    });

    it('channels.getMessages: has messages/users/chats/pts', () => {
      const fixture = loadFixture('channels.getMessages');
      if (!fixture?.response) return;

      expect(fixture.response.messages).toBeDefined();
      expect(fixture.response.users).toBeDefined();
      expect(fixture.response.chats).toBeDefined();
      expect(fixture.response.pts).toBeDefined();
    });

    it('channels.getParticipant__self: has participant/users/chats', () => {
      const fixture = loadFixture('channels.getParticipant__self');
      if (!fixture?.response) return;

      expect(fixture.response.participant).toBeDefined();
      expect(fixture.response.users).toBeDefined();
      expect(fixture.response.chats).toBeDefined();
    });

    it('channels.inviteToChannel: has missingInvitees/updates', () => {
      const fixture = loadFixture('channels.inviteToChannel');
      if (!fixture?.response) return;

      expect(fixture.response.missingInvitees).toBeDefined();
      expect(fixture.response.updates).toBeDefined();
    });

    it('channels.deleteChannel: has updates/users/chats', () => {
      const fixture = loadFixture('channels.deleteChannel');
      if (!fixture?.response) return;

      expect(fixture.response.updates).toBeDefined();
      expect(fixture.response.users).toBeDefined();
      expect(fixture.response.chats).toBeDefined();
    });

    it('messages.getAvailableEffects: has effects array', () => {
      const fixture = loadFixture('messages.getAvailableEffects');
      if (!fixture?.response) return;

      expect(fixture.response.effects).toBeDefined();
      expect(fixture.response.documents).toBeDefined();
    });

    it('messages.getEmojiKeywordsDifference: has langCode/keywords', () => {
      const fixture = loadFixture('messages.getEmojiKeywordsDifference');
      if (!fixture?.response) return;

      expect(fixture.response.langCode).toBeDefined();
      expect(fixture.response.keywords).toBeDefined();
    });

    it('messages.getEmojiURL: has url', () => {
      const fixture = loadFixture('messages.getEmojiURL');
      if (!fixture?.response) return;

      expect(fixture.response.url).toBeDefined();
    });

    it('messages.getStickers: has stickers array', () => {
      const fixture = loadFixture('messages.getStickers');
      if (!fixture?.response) return;

      expect(fixture.response.stickers).toBeDefined();
    });

    it('messages.getExportedChatInvites: has invites/users', () => {
      const fixture = loadFixture('messages.getExportedChatInvites');
      if (!fixture?.response) return;

      expect(fixture.response.invites).toBeDefined();
      expect(fixture.response.users).toBeDefined();
    });

    it('messages.getChatInviteImporters: has importers/users', () => {
      const fixture = loadFixture('messages.getChatInviteImporters');
      if (!fixture?.response) return;

      expect(fixture.response.importers).toBeDefined();
      expect(fixture.response.users).toBeDefined();
    });

    it('messages.sendReaction: has updates/users/chats', () => {
      const fixture = loadFixture('messages.sendReaction');
      if (!fixture?.response) return;

      expect(fixture.response.updates).toBeDefined();
      expect(fixture.response.users).toBeDefined();
      expect(fixture.response.chats).toBeDefined();
    });

    it('messages.getSavedHistory: has messages/users/chats', () => {
      const fixture = loadFixture('messages.getSavedHistory');
      if (!fixture?.response) return;

      expect(fixture.response.messages).toBeDefined();
      expect(fixture.response.users).toBeDefined();
      expect(fixture.response.chats).toBeDefined();
    });

    it('messages.getScheduledHistory: has messages/users/chats', () => {
      const fixture = loadFixture('messages.getScheduledHistory');
      if (!fixture?.response) return;

      expect(fixture.response.messages).toBeDefined();
      expect(fixture.response.users).toBeDefined();
      expect(fixture.response.chats).toBeDefined();
    });

    it('payments.getStarGifts: has gifts array', () => {
      const fixture = loadFixture('payments.getStarGifts');
      if (!fixture?.response) return;

      expect(fixture.response.gifts).toBeDefined();
    });

    it('payments.getSavedStarGifts: has gifts/count', () => {
      const fixture = loadFixture('payments.getSavedStarGifts');
      if (!fixture?.response) return;

      expect(fixture.response.count).toBeDefined();
      expect(fixture.response.gifts).toBeDefined();
    });

    it('messages.getCustomEmojiDocuments: is array of Documents', () => {
      const fixture = loadFixture('messages.getCustomEmojiDocuments');
      if (!fixture?.response) return;

      expect(Array.isArray(fixture.response)).toBe(true);
      if (fixture.response.length > 0) {
        expect(fixture.response[0].id).toBeDefined();
      }
    });

    it('messages.getAllDrafts: has updates array', () => {
      const fixture = loadFixture('messages.getAllDrafts');
      if (!fixture?.response) return;

      expect(fixture.response.updates).toBeDefined();
    });
  });
});
