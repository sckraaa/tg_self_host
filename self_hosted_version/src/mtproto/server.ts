import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { createServer as createTcpServer, type Socket } from 'net';
import { AuthHandler } from './auth.js';
import { BinaryReader, BinaryWriter } from './codec.js';
import { sha256Sync, sha1Sync, IGE, CTR, generateRandomBytes } from '../crypto/utils.js';
import { getMessageStore } from '../database/messageStore.js';
import { buildRpcErrorObject, buildUpdateUserStatus } from './builders.js';
import { isFieldVisibleByPrivacy } from './writers.js';
import { handleTlRequest, type HandlerCallbacks } from './handlers.js';
import { rpcLimiter } from '../utils/rateLimiter.js';

const clients = new Map<string, ClientSession>();
const authHandler = new AuthHandler();
const messageStore = getMessageStore();
let lastGeneratedMessageId = 0n;

// Map authKeyIdHex → userId for restoring auth state on reconnect
const authKeyUserMap = new Map<string, number>();

// Load persisted auth keys from SQLite on startup
{
  const persistedKeys = messageStore.loadAllAuthKeys();
  for (const { keyIdHex, authKey, userId } of persistedKeys) {
    authHandler.loadAuthKey(keyIdHex, authKey);
    if (userId) {
      authKeyUserMap.set(keyIdHex, userId);
    }
  }
  if (persistedKeys.length > 0) {
    console.log(`[STARTUP] Loaded ${persistedKeys.length} persisted auth key(s)`);
  }
}

function getKeyIdHex(authKey: Buffer): string {
  return sha1Sync(authKey).slice(12, 20).toString('hex');
}

// Tracks (auth_key_id, session_id) pairs for which we have already announced
// a `new_session_created` notification to the client. Per MTProto spec a
// session is identified by (auth_key_id, session_id) — not by a transport
// connection — and `new_session_created` must be emitted at most once per
// session. Official Telegram clients (Android:
// Telegram-Android/TMessagesProj/jni/tgnet/ConnectionsManager.cpp around
// TL_new_session_created handling) use it as a signal that the server lost
// state, and in response they mark every already-pending request whose
// message_id is lower than `first_msg_id` for retransmission. Re-sending
// this notification on every TCP reconnect therefore forces the client to
// retransmit its entire init burst, which is exactly what we observed in
// production logs for the Android client. Web clients typically don't
// notice because GramJS rarely has in-flight requests at the moment of
// reconnect.
const announcedSessions = new Set<string>();

function sessionAnnounceKey(authKeyId: bigint, sessionId: Buffer): string {
  // Use an unambiguous separator so key collisions are impossible.
  return `${authKeyId.toString(16)}|${sessionId.toString('hex')}`;
}

function constructorIdPeek(buf: Buffer): number {
  return buf.length >= 4 ? buf.readUInt32LE(0) : 0;
}

export interface ClientSession {
  id: string;
  socket?: WebSocket;           // WebSocket transport (web clients)
  tcpSocket?: Socket;           // TCP transport (mobile clients)
  sendRaw: (data: Buffer) => void;  // unified send — set by transport layer
  authKey?: Buffer;
  keyId?: bigint;
  dcId: number;
  userId?: number;
  connectedAt: number;
  lastActivityAt: number;
  handshakeComplete?: boolean;
  obfuscated?: boolean;
  encryptor?: CTR;
  decryptor?: CTR;
  serverSalt?: Buffer;
  sessionId?: Buffer;
  sentNewSessionCreated?: boolean;
  layer?: number;
  langCode?: string;           // client language from initConnection
  serverSeqNo: number;         // monotonic seq_no counter (number of content-related msgs sent * 2)
  pendingAckMsgIds: bigint[];  // incoming msg_ids that need acknowledgement
}

function generateClientId(): string {
  return `sess_${Date.now()}_${Math.random().toString(36).substring(2, 12)}`;
}

// MTProto seq_no: content-related messages get odd seq_no (2*n+1),
// non-content messages get even seq_no (2*n).
function getNextSeqNo(session: ClientSession, contentRelated: boolean): number {
  const seqNo = contentRelated
    ? session.serverSeqNo * 2 + 1
    : session.serverSeqNo * 2;
  if (contentRelated) {
    session.serverSeqNo++;
  }
  return seqNo;
}

function generateMessageId(): bigint {
  const nowMs = BigInt(Date.now());
  const seconds = nowMs / 1000n;
  const nanoseconds = (nowMs % 1000n) * 1000000n;
  let msgId = (seconds << 32n) | (nanoseconds << 2n) | 1n;

  if (msgId <= lastGeneratedMessageId) {
    msgId = lastGeneratedMessageId + 4n;
  }

  lastGeneratedMessageId = msgId;
  return msgId;
}

export function startServer(port: number, host: string) {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK\n');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws: WebSocket, req) => {
    const clientId = generateClientId();
    const session: ClientSession = {
      id: clientId,
      socket: ws,
      sendRaw: (data: Buffer) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      },
      dcId: 2,
      userId: undefined,
      connectedAt: Date.now(),
      lastActivityAt: Date.now(),
      serverSeqNo: 0,
      pendingAckMsgIds: [],
    };
    clients.set(clientId, session);

    console.log(`[${new Date().toISOString()}] Client connected: ${clientId}`);

    // Ciphertext buffered before obfuscation handshake completes (first 64 bytes).
    // After handshake, everything goes through plainBuffer below.
    let cipherPrefix: Buffer = Buffer.alloc(0);
    // Decrypted plaintext waiting to be parsed into frames. Never re-decrypted.
    let plainBuffer: Buffer = Buffer.alloc(0);

    ws.on('message', (data: unknown) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as Buffer);
      session.lastActivityAt = Date.now();

      try {
        if (!session.obfuscated) {
          cipherPrefix = Buffer.concat([cipherPrefix, chunk]);
          if (cipherPrefix.length < 64) return;
          const header = cipherPrefix.slice(0, 64);
          setupObfuscation(header, session);
          if (cipherPrefix.length > 64 && session.decryptor) {
            plainBuffer = Buffer.concat([plainBuffer, session.decryptor.decrypt(Buffer.from(cipherPrefix.slice(64)))]);
          }
          cipherPrefix = Buffer.alloc(0);
        } else if (session.decryptor) {
          plainBuffer = Buffer.concat([plainBuffer, session.decryptor.decrypt(Buffer.from(chunk))]);
        }

        while (plainBuffer.length > 0) {
          const frame = parseFrame(plainBuffer, session);
          if (!frame) break;
          plainBuffer = frame.remaining;
          if (frame.response && frame.response.length > 0) {
            ws.send(frame.response);
          }
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Session ${session.id} processing error:`, (error as Error).message);
        plainBuffer = Buffer.alloc(0);
        cipherPrefix = Buffer.alloc(0);
      }
    });

    ws.on('close', () => {
      console.log(`[${new Date().toISOString()}] Client disconnected: ${clientId}`);
      const disconnectedUserId = session.userId;
      authHandler.clearAuthState(clientId);
      clients.delete(clientId);

      // Check if this user still has other active sessions; if not, mark offline
      if (disconnectedUserId) {
        let hasOtherSessions = false;
        for (const otherSession of clients.values()) {
          if (otherSession.userId === disconnectedUserId) {
            hasOtherSessions = true;
            break;
          }
        }
        if (!hasOtherSessions) {
          messageStore.setUserOffline(disconnectedUserId);
          // Broadcast offline status to all connected users (respecting privacy)
          for (const otherSession of clients.values()) {
            if (otherSession.userId && otherSession.userId !== disconnectedUserId) {
              const statusVisible = isFieldVisibleByPrivacy(disconnectedUserId, otherSession.userId, 'statusTimestamp');
              const statusUpdate = buildUpdateUserStatus(disconnectedUserId, true, statusVisible);
              sendSessionUpdate(otherSession, statusUpdate);
            }
          }
          console.log(`[${new Date().toISOString()}] User ${disconnectedUserId} is now offline`);
        }
      }
    });

    ws.on('error', (error) => {
      console.error(`[${new Date().toISOString()}] Client ${clientId} error:`, error);
    });
  });

  server.listen(port, host, () => {
    console.log(`[${new Date().toISOString()}] MTProto server running on ${host}:${port}`);
  });

  // Periodic session cleanup: remove sessions inactive for 30 days
  const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
  setInterval(() => {
    const cleaned = messageStore.cleanupExpiredSessions(SESSION_TTL_SECONDS);
    if (cleaned > 0) {
      console.log(`[${new Date().toISOString()}] Cleaned up ${cleaned} expired session(s)`);
    }
  }, 60 * 60 * 1000); // check every hour

  return { server, wss, clients };
}

interface FrameResult {
  remaining: Buffer;
  response: Buffer | null;
}

// Initialize the obfuscated2 CTR ciphers from the client's 64-byte handshake header.
// See Telegram MTProto docs §"Transport obfuscation".
// Client:
//   encryptKey = bytes[8..40]      decryptKey = reversed(bytes[8..56])[0..32]
//   encryptIv  = bytes[40..56]     decryptIv  = reversed(bytes[8..56])[32..48]
// Server is the mirror: server.decrypt uses client.encrypt keys and vice versa.
function setupObfuscation(header: Buffer, session: ClientSession): void {
  const decryptKey = Buffer.from(header.slice(8, 40));
  const decryptIv = Buffer.from(header.slice(40, 56));
  const reversed = Buffer.from(header.slice(8, 56)).reverse();
  const encryptKey = Buffer.from(reversed.slice(0, 32));
  const encryptIv = Buffer.from(reversed.slice(32, 48));

  session.decryptor = new CTR(decryptKey, decryptIv);
  session.encryptor = new CTR(encryptKey, encryptIv);

  const decryptedHeader = session.decryptor.decrypt(Buffer.from(header));
  const tag = decryptedHeader.slice(56, 60);
  const expectedTag = Buffer.from('efefefef', 'hex');
  if (!tag.equals(expectedTag)) {
    console.log(`[${new Date().toISOString()}] Session ${session.id} obfuscation tag: ${tag.toString('hex')} (expected efefefef)`);
  }

  session.obfuscated = true;
  session.handshakeComplete = true;
  console.log(`[${new Date().toISOString()}] [DIAG] Session ${session.id} obfuscation handshake OK (tag=${tag.toString('hex')})`);
}

// Parse a single abridged-transport frame from an already-decrypted plaintext buffer.
// Returns null if the buffer doesn't yet contain a complete frame (caller should
// accumulate more plaintext and retry). On success returns the remaining plaintext
// and the response to send back (may be null if no response is produced).
function parseFrame(plain: Buffer, session: ClientSession): FrameResult | null {
  if (plain.length < 1) return null;

  let msgLen: number;
  let headerLen: number;
  if (plain[0] >= 0x7f) {
    if (plain.length < 4) return null;
    msgLen = plain[1] | (plain[2] << 8) | (plain[3] << 16);
    headerLen = 4;
  } else {
    msgLen = plain[0];
    headerLen = 1;
  }
  msgLen = msgLen << 2;

  if (plain.length < headerLen + msgLen) {
    // Not enough bytes yet — wait for more data, do NOT advance any state.
    return null;
  }

  const msgData = plain.slice(headerLen, headerLen + msgLen);
  const remaining = Buffer.from(plain.slice(headerLen + msgLen));

  const authKeyId = msgData.readBigInt64LE(0);
  if (authKeyId === 0n) {
    const innerPayload = msgData.length >= 20 ? msgData.slice(20) : msgData;
    const response = handleUnencryptedAuthPayload(innerPayload, session);
    return { remaining, response };
  }
  const response = handleEncryptedMessage(msgData, session);
  return { remaining, response };
}

function handleUnencryptedAuthPayload(buffer: Buffer, session: ClientSession): Buffer | null {
  const reader = new BinaryReader(buffer);
  const constructorId = reader.peekConstructorId();
  const ts = () => new Date().toISOString();

  switch (constructorId) {
    case 0xbe7e8ef1: // req_pq_multi
    case 0x60469778: // req_pq (legacy)
    {
      console.log(`[${ts()}] [DIAG] Session ${session.id} <- req_pq_multi (ctor=0x${constructorId.toString(16)}, ${buffer.length}B)`);
      const result = authHandler.processReqPqMultiSync(buffer, session.id);
      console.log(`[${ts()}] [DIAG] Session ${session.id} -> res_pq (${result.length}B)`);
      return createObfuscatedResponse(result, session);
    }
    case 0xd712e4be: { // ReqDHParams
      console.log(`[${ts()}] [DIAG] Session ${session.id} <- req_DH_params (${buffer.length}B)`);
      const result = authHandler.processReqDHParamsSync(buffer, session.id);
      console.log(`[${ts()}] [DIAG] Session ${session.id} -> server_DH_params (${result.length}B)`);
      return createObfuscatedResponse(result, session);
    }
    case 0xf5045f1f: { // set_client_DH_params
      console.log(`[${ts()}] [DIAG] Session ${session.id} <- set_client_DH_params (${buffer.length}B)`);
      const result = authHandler.processSetClientDHParamsSync(buffer, session.id);
      // Persist newly created auth key to SQLite
      for (const entry of authHandler.getAllAuthKeys()) {
        messageStore.saveAuthKey(entry.keyIdHex, entry.authKey);
      }
      console.log(`[${ts()}] [DIAG] Session ${session.id} -> dh_gen_ok (${result.length}B, auth_key established)`);
      return createObfuscatedResponse(result, session);
    }
    case 0x62d6b459: // msgs_ack — Android acks our handshake responses; no response needed.
      return null;
    default:
      console.log(`[${ts()}] [DIAG] Session ${session.id} UNKNOWN auth payload ctor=0x${constructorId.toString(16)} (${buffer.length}B): ${buffer.slice(0, Math.min(64, buffer.length)).toString('hex')}`);
      return null;
  }
}

function createObfuscatedResponse(data: Buffer, session: ClientSession): Buffer {
  const authKeyIdBuf = Buffer.alloc(8);
  const msgId = Buffer.alloc(8);
  msgId.writeBigInt64LE(generateMessageId(), 0);
  const msgLen = Buffer.alloc(4);
  msgLen.writeInt32LE(data.length, 0);

  const envelope = Buffer.concat([authKeyIdBuf, msgId, msgLen, data]);
  const length = envelope.length >> 2;
  let frame: Buffer;
  if (length < 127) {
    frame = Buffer.concat([Buffer.from([length]), envelope]);
  } else {
    const header = Buffer.alloc(4);
    header[0] = 0x7f;
    header[1] = length & 0xff;
    header[2] = (length >> 8) & 0xff;
    header[3] = (length >> 16) & 0xff;
    frame = Buffer.concat([header, envelope]);
  }
  if (session.encryptor) {
    return session.encryptor.encrypt(frame);
  }
  return frame;
}

function isServiceMessage(constructorId: number): boolean {
  return (
    constructorId === 0xf3427b8c || // ping_delay_disconnect
    constructorId === 0x7abe77ec || // ping
    constructorId === 0x62d6b459    // msgs_ack
  );
}

function handleEncryptedMessage(data: Buffer, session: ClientSession): Buffer | null {
  const authKeyId = data.readBigInt64LE(0);
  let authKey = authHandler.getAuthKey(session.id);

  if (!authKey) {
    // Try to find auth key by auth_key_id from the message header
    authKey = authHandler.getAuthKeyByKeyId(authKeyId);
    if (authKey) {
      // Bind this auth key to the current session for future lookups
      authHandler.bindAuthKeyToSession(session.id, authKeyId);
      // Restore userId from auth_key → user mapping
      const keyHex = getKeyIdHex(authKey);
      const mappedUserId = authKeyUserMap.get(keyHex);
      if (mappedUserId) {
        session.userId = mappedUserId;
        messageStore.setUserOnline(mappedUserId);
      }
      console.log(`[${new Date().toISOString()}] Session ${session.id} recovered auth key by keyId (userId=${session.userId || 'none'})`);
      session.authKey = authKey;
    }
  }

  if (!authKey) {
    console.log(`[${new Date().toISOString()}] Session ${session.id} no auth key for encrypted message (keyId=0x${authKeyId.toString(16)})`);
    return null;
  }

  // Always store authKey on session for use in auth handlers
  if (!session.authKey) {
    session.authKey = authKey;
  }

  // Touch session activity for TTL tracking
  const sessionKeyHex = getKeyIdHex(authKey);
  messageStore.touchSession(sessionKeyHex);

  // MTProto 2.0 encrypted message:
  // auth_key_id(8) + msg_key(16) + encrypted_data(N)
  const msgKey = data.slice(8, 24);
  const encryptedPayload = data.slice(24);

  // Derive AES key/iv from msg_key and auth_key (client→server: x=0)
  // sha256_a = SHA256(msg_key + substr(auth_key, x, 36))    x=0 → [0:36]
  // sha256_b = SHA256(substr(auth_key, 40+x, 36) + msg_key) x=0 → [40:76]
  const sha256a = sha256Sync(Buffer.concat([msgKey, authKey.slice(0, 36)]));
  const sha256b = sha256Sync(Buffer.concat([authKey.slice(40, 76), msgKey]));

  const aesKey = Buffer.concat([sha256a.slice(0, 8), sha256b.slice(8, 24), sha256a.slice(24, 32)]);
  const aesIv = Buffer.concat([sha256b.slice(0, 8), sha256a.slice(8, 24), sha256b.slice(24, 32)]);

  // Decrypt with IGE
  const ige = new IGE(aesKey, aesIv);
  const decryptedData = ige.decryptIge(encryptedPayload);

  // Parse inner message:
  // server_salt(8) + session_id(8) + message_id(8) + seq_no(4) + message_data_length(4) + message_data
  const serverSalt = decryptedData.slice(0, 8);
  const sessionId = decryptedData.slice(8, 16);
  const messageId = decryptedData.readBigInt64LE(16);
  const seqNo = decryptedData.readInt32LE(24);
  const msgDataLen = decryptedData.readInt32LE(28);
  const innerData = decryptedData.slice(32, 32 + msgDataLen);

  // Store session salt and session ID
  session.serverSalt = serverSalt;
  session.sessionId = sessionId;

  // If the outer encrypted message is a msg_container, peek at the inner
  // messages and take the SMALLEST inner msg_id. This is needed both for
  // the `first_msg_id` field of `new_session_created` (see below) and so
  // that we never advertise an id that is greater than any request the
  // client currently has in flight. Parsing is cheap: we only walk the
  // header (msg_id + seq_no + bytes) and skip the body.
  let minInnerMsgId: bigint | null = null;
  if (constructorIdPeek(innerData) === 0x73f1f8dc) {
    const countI = innerData.readInt32LE(4);
    let offI = 8;
    for (let i = 0; i < countI; i++) {
      if (offI + 16 > innerData.length) break;
      const innerMsgId = innerData.readBigInt64LE(offI); offI += 8;
      offI += 4; // seq_no
      const bodyLen = innerData.readInt32LE(offI); offI += 4;
      offI += bodyLen;
      if (minInnerMsgId === null || innerMsgId < minInnerMsgId) {
        minInnerMsgId = innerMsgId;
      }
    }
  }

  // Emit `new_session_created` at most once per (auth_key_id, session_id)
  // pair across the entire process lifetime. Sending it on every TCP
  // reconnect causes Android's ConnectionsManager to retransmit every
  // already-running request whose msg_id is below `first_msg_id`, which
  // manifested as the client re-uploading its entire init burst ~750ms
  // after the first one on every reconnect.
  //
  // For `first_msg_id` we MUST pick the smallest msg_id we are currently
  // willing to process — NOT the outer envelope's msg_id. Android (see
  // Telegram-Android/TMessagesProj/jni/tgnet/ConnectionsManager.cpp around
  // the TL_new_session_created branch) iterates its `runningRequests` and
  // calls `request->clear(true)` for every request whose
  // `messageId < first_msg_id`, forcing those requests to be retransmitted
  // in the "new" session. When a client ships multiple RPCs inside a
  // msg_container, the container's outer msg_id is strictly greater than
  // every inner msg_id (MTProto §"Containers"). Advertising the outer id
  // therefore wipes every inner request out of runningRequests and the
  // whole burst comes back ~1s later — exactly the behaviour we saw in
  // production logs.
  //
  // Using the smallest inner msg_id (or the single-message msg_id for
  // non-container payloads) is semantically correct: it is the first
  // msg_id of the new session that we have observed, matches what the
  // client will have in its runningRequests for this request, and leaves
  // earlier server-side state (none for us) still eligible to be
  // dropped/resent by the client. Web clients don't care either way
  // because GramJS rarely has in-flight requests when new_session_created
  // arrives.
  let newSessionMsg: Buffer | null = null;
  const announceKey = sessionAnnounceKey(authKeyId, sessionId);
  if (!session.sentNewSessionCreated && !announcedSessions.has(announceKey)) {
    session.sentNewSessionCreated = true;
    announcedSessions.add(announceKey);
    session.serverSeqNo = 0;         // reset seq_no counter for new session
    session.pendingAckMsgIds = [];   // clear pending acks
    const firstMsgId = minInnerMsgId !== null ? minInnerMsgId : messageId;
    const nsW = new BinaryWriter();
    nsW.writeInt(0x9ec20908);  // new_session_created
    nsW.writeLong(firstMsgId); // first_msg_id
    nsW.writeLong(BigInt(Date.now()) * 1000000n); // unique_id
    nsW.writeLong(serverSalt.readBigInt64LE(0));   // server_salt
    newSessionMsg = nsW.getBytes();
    console.log(`[${new Date().toISOString()}] Session ${session.id} sending new_session_created (first_msg_id=0x${firstMsgId.toString(16)})`);
  } else if (!session.sentNewSessionCreated) {
    // Already announced for this (auth_key, session_id) on a previous
    // transport connection — mark the per-connection flag so the rest of
    // this function's branches don't try to emit a duplicate.
    session.sentNewSessionCreated = true;
  }

  // Parse TL constructor from inner data
  const constructorId = innerData.readUInt32LE(0);
  console.log(`[${new Date().toISOString()}] [DIAG] Session ${session.id} <- encrypted msg ctor=0x${constructorId.toString(16)} (msgDataLen=${msgDataLen}, authKeyId=0x${authKeyId.toString(16)})`);

  // Track incoming msg_id for acknowledgement (content-related messages only)
  const clientSeqNo = seqNo;
  if (clientSeqNo % 2 === 1) {
    // Odd seq_no = content-related → needs ack
    session.pendingAckMsgIds.push(messageId);
  }

  // Handle msg_container
  if (constructorId === 0x73f1f8dc) {
    // IMPORTANT: encrypt and send new_session_created BEFORE the container,
    // so CTR cipher state advances in the same order as the send order.
    if (newSessionMsg) {
      const nsBuf = createEncryptedResponse(newSessionMsg, 0n, session, authKey, false);
      session.sendRaw(nsBuf);
    }
    const containerResp = handleMsgContainer(innerData, messageId, session, authKey);
    // Send pending msgs_ack after container processing
    flushPendingAcks(session, authKey);
    return containerResp;
  }

  // Service messages that should NOT be wrapped in rpc_result
  if (isServiceMessage(constructorId)) {
    const responseData = handleTlRequest(innerData, session, messageId, getHandlerCtx());
    if (newSessionMsg) {
      const nsBuf = createEncryptedResponse(newSessionMsg, 0n, session, authKey, false);
      session.sendRaw(nsBuf);
    }
    if (!responseData) return null;
    // pong, msgs_ack responses are NOT content-related
    return createEncryptedResponse(responseData, messageId, session, authKey, false);
  }

  // RPC call: rate limit check
  if (!rpcLimiter.check(session.id)) {
    console.log(`[${new Date().toISOString()}] Session ${session.id} RATE LIMITED`);
    const floodError = buildRpcErrorObject(420, 'FLOOD_WAIT_30');
    if (newSessionMsg) {
      const nsBuf = createEncryptedResponse(newSessionMsg, 0n, session, authKey, false);
      session.sendRaw(nsBuf);
    }
    const rpcFlood = new BinaryWriter();
    rpcFlood.writeInt(0xf35c6d01);
    rpcFlood.writeLong(messageId);
    rpcFlood.writeBytes(floodError);
    return createEncryptedResponse(rpcFlood.getBytes(), messageId, session, authKey, true);
  }

  // RPC call: process and wrap in rpc_result
  let responseData: Buffer | null = null;
  try {
    responseData = handleTlRequest(innerData, session, messageId, getHandlerCtx());
  } catch (err) {
    const cid = innerData.readUInt32LE(0);
    console.error(`[${new Date().toISOString()}] Session ${session.id} HANDLER ERROR for 0x${cid.toString(16)}:`, err);
    responseData = buildRpcErrorObject(500, 'INTERNAL_ERROR');
  }
  if (newSessionMsg) {
    const nsBuf = createEncryptedResponse(newSessionMsg, 0n, session, authKey, false);
    session.sendRaw(nsBuf);
  }
  if (!responseData) return null;

  const rpcResult = new BinaryWriter();
  rpcResult.writeInt(0xf35c6d01);  // rpc_result constructor
  rpcResult.writeLong(messageId);   // req_msg_id
  rpcResult.writeBytes(responseData);

  // Send pending msgs_ack before rpc_result
  flushPendingAcks(session, authKey);

  return createEncryptedResponse(rpcResult.getBytes(), messageId, session, authKey, true);
}

function handleMsgContainer(data: Buffer, containerMsgId: bigint, session: ClientSession, authKey: Buffer): Buffer | null {
  // msg_container#73f1f8dc count:int messages:...
  const count = data.readInt32LE(4);
  let offset = 8; // skip constructor(4) + count(4)

  const responses: Buffer[] = [];
  const responseIsContent: boolean[] = [];  // track content-related per response

  for (let i = 0; i < count; i++) {
    if (offset + 16 > data.length) break;
    const msgId = data.readBigInt64LE(offset); offset += 8;
    const seqNo = data.readInt32LE(offset); offset += 4;
    const bodyLen = data.readInt32LE(offset); offset += 4;
    const body = data.slice(offset, offset + bodyLen); offset += bodyLen;

    const innerConstructor = body.readUInt32LE(0);

    // Track content-related incoming messages for ack
    if (seqNo % 2 === 1) {
      session.pendingAckMsgIds.push(msgId);
    }

    let responseData: Buffer | null = null;
    try {
      responseData = handleTlRequest(body, session, msgId, getHandlerCtx());
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Session ${session.id} HANDLER ERROR for 0x${innerConstructor.toString(16)}:`, err);
      responseData = buildRpcErrorObject(500, 'INTERNAL_ERROR');
    }
    if (responseData) {
      if (isServiceMessage(innerConstructor)) {
        // Service messages (ping, msgs_ack) — send response directly, no rpc_result
        responses.push(responseData);
        responseIsContent.push(false);
      } else {
        const rpcResult = new BinaryWriter();
        rpcResult.writeInt(0xf35c6d01);
        rpcResult.writeLong(msgId);
        rpcResult.writeBytes(responseData);
        responses.push(rpcResult.getBytes());
        responseIsContent.push(true);
      }
    }
  }

  // Build msgs_ack for all content-related messages in this container
  if (session.pendingAckMsgIds.length > 0) {
    const ackW = new BinaryWriter();
    ackW.writeInt(0x62d6b459); // msgs_ack
    ackW.writeInt(0x1cb5c415); // vector constructor
    ackW.writeInt(session.pendingAckMsgIds.length);
    for (const id of session.pendingAckMsgIds) {
      ackW.writeLong(id);
    }
    session.pendingAckMsgIds = [];
    responses.push(ackW.getBytes());
    responseIsContent.push(false);
  }

  if (responses.length === 0) return null;

  // Wrap all responses in a msg_container.
  //
  // Each inner message MUST have a unique, monotonically-increasing msg_id
  // that is also globally unique across all containers and the outer envelope
  // we will emit for this response. The previous implementation reserved a
  // single base msg_id via generateMessageId() and then incremented it by
  // +4n per inner message without updating the global lastGeneratedMessageId
  // counter. On bursts (multiple RPCs within the same millisecond) the next
  // generateMessageId() call — in particular the one used for the outer
  // envelope msg_id in createEncryptedResponse — would collide with one of
  // the inner msg_ids we already handed out. Official clients (Android's
  // ConnectionSession::isMessageIdProcessed) silently drop messages whose
  // msg_id they have already seen, so the client would never process the
  // rpc_result and would keep retrying its request. Calling generateMessageId()
  // once per inner message keeps the counter strictly monotonic and
  // collision-free for both inner and outer ids.
  const containerW = new BinaryWriter();
  containerW.writeInt(0x73f1f8dc); // msg_container
  containerW.writeInt(responses.length);
  for (let i = 0; i < responses.length; i++) {
    containerW.writeLong(generateMessageId());
    containerW.writeInt(getNextSeqNo(session, responseIsContent[i]));
    containerW.writeInt(responses[i].length);
    containerW.writeBytes(responses[i]);
  }

  // msg_container itself is NOT content-related
  return createEncryptedResponse(containerW.getBytes(), containerMsgId, session, authKey, false);
}


function getHandlerCtx(): HandlerCallbacks {
  return {
    authKeyUserMap,
    broadcastToUser,
    broadcastSessionUpdates,
    removeAuthKey: (key: Buffer) => authHandler.removeAuthKey(key),
    sendDeferredRpcResult: (session: ClientSession, reqMsgId: bigint, payload: Buffer) => {
      // Wrap the payload in rpc_result and send it out-of-band. Used by handlers
      // that return `null` synchronously and complete asynchronously (e.g.
      // `messages.getWebPagePreview` awaiting an OpenGraph fetch).
      const authKey = session.authKey;
      if (!authKey) return;
      if (!session.socket && !session.tcpSocket) return;
      const rpcResult = new BinaryWriter();
      rpcResult.writeInt(0xf35c6d01); // rpc_result
      rpcResult.writeLong(reqMsgId);
      rpcResult.writeBytes(payload);
      try {
        const encrypted = createEncryptedResponse(rpcResult.getBytes(), reqMsgId, session, authKey, true);
        session.sendRaw(encrypted);
      } catch (e) {
        console.error(`[${new Date().toISOString()}] sendDeferredRpcResult failed:`, (e as Error).message);
      }
    },
  };
}

// Send accumulated msgs_ack to the client for all pending content-related messages
function flushPendingAcks(session: ClientSession, authKey: Buffer): void {
  if (session.pendingAckMsgIds.length === 0) return;
  const ackW = new BinaryWriter();
  ackW.writeInt(0x62d6b459); // msgs_ack
  ackW.writeInt(0x1cb5c415); // vector constructor
  ackW.writeInt(session.pendingAckMsgIds.length);
  for (const id of session.pendingAckMsgIds) {
    ackW.writeLong(id);
  }
  session.pendingAckMsgIds = [];
  const ackBuf = createEncryptedResponse(ackW.getBytes(), 0n, session, authKey, false);
  session.sendRaw(ackBuf);
}

function createEncryptedResponse(responseData: Buffer, reqMsgId: bigint, session: ClientSession, authKey: Buffer, contentRelated = true): Buffer {
  // Build inner message
  const innerW = new BinaryWriter();
  innerW.writeBytes(session.serverSalt || Buffer.alloc(8));  // server_salt
  innerW.writeBytes(session.sessionId || Buffer.alloc(8));   // session_id
  // message_id (server response: must be slightly after request)  
  const respMsgId = generateMessageId();
  innerW.writeLong(respMsgId);
  innerW.writeInt(getNextSeqNo(session, contentRelated));  // seq_no
  innerW.writeInt(responseData.length);  // message_data_length
  innerW.writeBytes(responseData);

  // Add padding (12-1024 bytes, total must be divisible by 16)
  const innerBytes = innerW.getBytes();
  let paddingLen = 12 + ((16 - ((innerBytes.length + 12) % 16)) % 16);
  if (paddingLen < 12) paddingLen += 16;
  const padded = Buffer.concat([innerBytes, generateRandomBytes(paddingLen)]);

  // Compute msg_key (server→client: x=8)
  const msgKeyLarge = sha256Sync(Buffer.concat([authKey.slice(96, 128), padded]));
  const msgKey = msgKeyLarge.slice(8, 24);

  // Derive AES key/iv (server→client: x=8 → auth_key[8:44] and auth_key[48:84])
  const sha256a = sha256Sync(Buffer.concat([msgKey, authKey.slice(8, 44)]));
  const sha256b = sha256Sync(Buffer.concat([authKey.slice(48, 84), msgKey]));
  const aesKey = Buffer.concat([sha256a.slice(0, 8), sha256b.slice(8, 24), sha256a.slice(24, 32)]);
  const aesIv = Buffer.concat([sha256b.slice(0, 8), sha256a.slice(8, 24), sha256b.slice(24, 32)]);

  // Encrypt with IGE
  const ige = new IGE(aesKey, aesIv);
  const encryptedData = ige.encryptIge(padded);

  // Build outer message: auth_key_id(8) + msg_key(16) + encrypted_data
  const authKeyHash = sha1Sync(authKey);
  const authKeyIdBuf = authKeyHash.slice(12, 20); // lower 64 bits
  const envelope = Buffer.concat([authKeyIdBuf, msgKey, encryptedData]);

  // Abridged frame + CTR encrypt
  const length = envelope.length >> 2;
  let frame: Buffer;
  if (length < 127) {
    frame = Buffer.concat([Buffer.from([length]), envelope]);
  } else {
    const header = Buffer.alloc(4);
    header[0] = 0x7f;
    header[1] = length & 0xff;
    header[2] = (length >> 8) & 0xff;
    header[3] = (length >> 16) & 0xff;
    frame = Buffer.concat([header, envelope]);
  }

  if (session.encryptor) {
    return session.encryptor.encrypt(frame);
  }
  return frame;
}

function sendSessionUpdate(session: ClientSession, responseData: Buffer): void {
  if (!session.serverSalt || !session.sessionId) {
    return;
  }

  const authKey = authHandler.getAuthKey(session.id);
  if (!authKey) {
    return;
  }

  session.sendRaw(createEncryptedResponse(responseData, 0n, session, authKey));
}

function broadcastSessionUpdates(sourceSession: ClientSession, responseData: Buffer | null): void {
  if (!responseData) {
    return;
  }

  // No userId on the source session means the originator is unauthenticated —
  // refuse to broadcast anything. Falling back to SEED_USER_ID here would leak
  // updates to all sessions owned by user 100000.
  const sourceUserId = sourceSession.userId;
  if (!sourceUserId) {
    return;
  }

  let sentCount = 0;
  for (const targetSession of clients.values()) {
    if (targetSession.id === sourceSession.id) {
      continue;
    }

    // Skip download sessions (no userId bound) to avoid sending them unexpected updates
    if (!targetSession.userId) {
      continue;
    }

    if (targetSession.userId !== sourceUserId) {
      continue;
    }

    sendSessionUpdate(targetSession, responseData);
    sentCount++;
  }
  if (sentCount > 0) {
    console.log(`[${new Date().toISOString()}] Broadcast from ${sourceSession.id}: ${responseData.length} bytes to ${sentCount} other sessions (total clients: ${clients.size})`);
  }
}

function broadcastToUser(targetUserId: number, responseData: Buffer | null, excludeSessionId?: string): void {
  if (!responseData) return;
  let sentCount = 0;
  for (const targetSession of clients.values()) {
    if (excludeSessionId && targetSession.id === excludeSessionId) continue;
    // Skip download sessions (no userId bound)
    if (!targetSession.userId) continue;
    if (targetSession.userId !== targetUserId) continue;
    sendSessionUpdate(targetSession, responseData);
    sentCount++;
  }
  if (sentCount > 0) {
    console.log(`[${new Date().toISOString()}] BroadcastToUser ${targetUserId}: ${responseData.length} bytes to ${sentCount} sessions`);
  }
}

// ─── TCP Transport ───────────────────────────────────────────────────────────
// Raw TCP server for mobile clients (iOS/Android/TDLib).
// Shares all protocol logic with the WebSocket server — only the transport
// layer (how bytes arrive/leave) is different.

export function startTcpServer(tcpPort: number, host: string): void {
  const tcpServer = createTcpServer((socket: Socket) => {
    const clientId = generateClientId();

    const session: ClientSession = {
      id: clientId,
      tcpSocket: socket,
      sendRaw: (data: Buffer) => {
        if (!socket.destroyed) socket.write(data);
      },
      dcId: 2,
      userId: undefined,
      connectedAt: Date.now(),
      lastActivityAt: Date.now(),
      serverSeqNo: 0,
      pendingAckMsgIds: [],
    };
    clients.set(clientId, session);

    const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[${new Date().toISOString()}] [TCP] Client connected: ${clientId} (${remoteAddr})`);

    // Ciphertext buffered before obfuscation handshake completes.
    let cipherPrefix: Buffer = Buffer.alloc(0);
    // Decrypted plaintext waiting to be parsed into frames. Never re-decrypted;
    // TCP delivers arbitrary byte-stream chunks so we must decrypt incrementally
    // (CTR state would otherwise desynchronise on partial frames).
    let plainBuffer: Buffer = Buffer.alloc(0);

    socket.on('data', (chunk: Buffer) => {
      session.lastActivityAt = Date.now();

      try {
        if (!session.obfuscated) {
          cipherPrefix = Buffer.concat([cipherPrefix, chunk]);
          if (cipherPrefix.length < 64) return;
          const header = cipherPrefix.slice(0, 64);
          setupObfuscation(header, session);
          if (cipherPrefix.length > 64 && session.decryptor) {
            plainBuffer = Buffer.concat([plainBuffer, session.decryptor.decrypt(Buffer.from(cipherPrefix.slice(64)))]);
          }
          cipherPrefix = Buffer.alloc(0);
        } else if (session.decryptor) {
          plainBuffer = Buffer.concat([plainBuffer, session.decryptor.decrypt(Buffer.from(chunk))]);
        }

        while (plainBuffer.length > 0) {
          const frame = parseFrame(plainBuffer, session);
          if (!frame) break;
          plainBuffer = frame.remaining;
          if (frame.response && frame.response.length > 0 && !socket.destroyed) {
            socket.write(frame.response);
          }
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] [TCP] Session ${session.id} processing error:`, (error as Error).message);
        plainBuffer = Buffer.alloc(0);
        cipherPrefix = Buffer.alloc(0);
      }
    });

    socket.on('close', () => {
      console.log(`[${new Date().toISOString()}] [TCP] Client disconnected: ${clientId}`);
      const disconnectedUserId = session.userId;
      authHandler.clearAuthState(clientId);
      clients.delete(clientId);

      if (disconnectedUserId) {
        let hasOtherSessions = false;
        for (const otherSession of clients.values()) {
          if (otherSession.userId === disconnectedUserId) {
            hasOtherSessions = true;
            break;
          }
        }
        if (!hasOtherSessions) {
          messageStore.setUserOffline(disconnectedUserId);
          for (const otherSession of clients.values()) {
            if (otherSession.userId && otherSession.userId !== disconnectedUserId) {
              const statusVisible = isFieldVisibleByPrivacy(disconnectedUserId, otherSession.userId, 'statusTimestamp');
              const statusUpdate = buildUpdateUserStatus(disconnectedUserId, true, statusVisible);
              sendSessionUpdate(otherSession, statusUpdate);
            }
          }
          console.log(`[${new Date().toISOString()}] [TCP] User ${disconnectedUserId} is now offline`);
        }
      }
    });

    socket.on('error', (err) => {
      // ECONNRESET / EPIPE are normal — mobile clients close connections abruptly
      if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET' &&
          (err as NodeJS.ErrnoException).code !== 'EPIPE') {
        console.error(`[${new Date().toISOString()}] [TCP] Client ${clientId} error:`, err.message);
      }
    });
  });

  tcpServer.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] [TCP] Server error:`, err);
  });

  tcpServer.listen(tcpPort, host, () => {
    console.log(`[${new Date().toISOString()}] [TCP] MTProto TCP server running on ${host}:${tcpPort}`);
  });
}
