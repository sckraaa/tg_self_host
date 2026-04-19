import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import * as net from 'net';
import { AuthHandler } from './auth.js';
import { BinaryReader, BinaryWriter } from './codec.js';
import { sha256Sync, sha1Sync, IGE, CTR, generateRandomBytes } from '../crypto/utils.js';
import { getMessageStore } from '../database/messageStore.js';
import { buildRpcErrorObject, buildUpdateUserStatus } from './builders.js';
import { isFieldVisibleByPrivacy } from './writers.js';
import { handleTlRequest } from './handlers.js';
import { rpcLimiter } from '../utils/rateLimiter.js';
const SEED_USER_ID = 100000;
const clients = new Map();
const authHandler = new AuthHandler();
const messageStore = getMessageStore();
let lastGeneratedMessageId = 0n;
// Map authKeyIdHex → userId for restoring auth state on reconnect
const authKeyUserMap = new Map();
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
function getKeyIdHex(authKey) {
    return sha1Sync(authKey).slice(12, 20).toString('hex');
}
function generateClientId() {
    return `sess_${Date.now()}_${Math.random().toString(36).substring(2, 12)}`;
}
function generateMessageId() {
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
export function startServer(port, host) {
    const tcpPort = parseInt(process.env.TCP_PORT || '8443');
    // Shared cleanup logic for disconnecting sessions
    function handleDisconnect(session) {
        console.log(`[${new Date().toISOString()}] Client disconnected: ${session.id}`);
        const disconnectedUserId = session.userId;
        session.send = undefined;
        authHandler.clearAuthState(session.id);
        clients.delete(session.id);
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
                console.log(`[${new Date().toISOString()}] User ${disconnectedUserId} is now offline`);
            }
        }
    }
    // Shared message processing logic
    function processSessionData(buffer, session) {
        let isPreDecrypted = false;
        let receiveBuffer = buffer;
        while (receiveBuffer.length > 0) {
            try {
                const result = processBuffer(receiveBuffer, session, isPreDecrypted);
                if (!result) {
                    // Store remaining data back for next time
                    return receiveBuffer;
                }
                receiveBuffer = result.remaining || Buffer.alloc(0);
                isPreDecrypted = result.preDecrypted || false;
                if (result.response && result.response.length > 0) {
                    session.send?.(result.response);
                }
            }
            catch (error) {
                console.error(`[${new Date().toISOString()}] Session ${session.id} processing error:`, error.message);
                return Buffer.alloc(0);
            }
        }
        return Buffer.alloc(0);
    }
    // --- WebSocket server ---
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
    wss.on('connection', (ws, req) => {
        const clientId = generateClientId();
        const session = {
            id: clientId,
            socket: ws,
            send: (data) => {
                if (ws.readyState === WebSocket.OPEN)
                    ws.send(data);
            },
            dcId: 2,
            userId: undefined,
            connectedAt: Date.now(),
            lastActivityAt: Date.now(),
        };
        clients.set(clientId, session);
        console.log(`[${new Date().toISOString()}] Client connected (WS): ${clientId}`);
        let receiveBuffer = Buffer.alloc(0);
        ws.on('message', (data) => {
            const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
            session.lastActivityAt = Date.now();
            receiveBuffer = Buffer.concat([receiveBuffer, buffer]);
            receiveBuffer = processSessionData(receiveBuffer, session);
        });
        ws.on('close', () => handleDisconnect(session));
        ws.on('error', (error) => {
            console.error(`[${new Date().toISOString()}] Client ${clientId} WS error:`, error);
        });
    });
    server.listen(port, host, () => {
        console.log(`[${new Date().toISOString()}] MTProto WebSocket server running on ${host}:${port}`);
    });
    // --- TCP server (for native clients like Telegram-iOS) ---
    const tcpServer = net.createServer((socket) => {
        const clientId = generateClientId();
        const session = {
            id: clientId,
            tcpSocket: socket,
            send: (data) => {
                if (!socket.destroyed)
                    socket.write(data);
            },
            dcId: 2,
            userId: undefined,
            connectedAt: Date.now(),
            lastActivityAt: Date.now(),
        };
        clients.set(clientId, session);
        console.log(`[${new Date().toISOString()}] Client connected (TCP): ${clientId}`);
        let receiveBuffer = Buffer.alloc(0);
        socket.on('data', (data) => {
            session.lastActivityAt = Date.now();
            receiveBuffer = Buffer.concat([receiveBuffer, data]);
            receiveBuffer = processSessionData(receiveBuffer, session);
        });
        socket.on('close', () => handleDisconnect(session));
        socket.on('error', (error) => {
            console.error(`[${new Date().toISOString()}] Client ${clientId} TCP error:`, error);
        });
    });
    tcpServer.listen(tcpPort, host, () => {
        console.log(`[${new Date().toISOString()}] MTProto TCP server running on ${host}:${tcpPort}`);
    });
    // Periodic session cleanup: remove sessions inactive for 30 days
    const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
    setInterval(() => {
        const cleaned = messageStore.cleanupExpiredSessions(SESSION_TTL_SECONDS);
        if (cleaned > 0) {
            console.log(`[${new Date().toISOString()}] Cleaned up ${cleaned} expired session(s)`);
        }
    }, 60 * 60 * 1000); // check every hour
    return { server, wss, tcpServer, clients };
}
function processBuffer(buffer, session, preDecrypted = false) {
    // Step 1: Handle obfuscation header (first 64 bytes from client)
    if (!session.obfuscated && !session.handshakeComplete) {
        if (buffer.length < 64) {
            return null; // wait for more data
        }
        const header = buffer.slice(0, 64);
        // Bytes 0-55 are plaintext, bytes 56-63 are encrypted by the client's encryptor.
        // Client encryptKey = header[8..40], encryptIv = header[40..56]
        // Reversed = header[8..56].reverse()
        // Server encryptKey = reversed[0..32], encryptIv = reversed[32..48]
        const decryptKey = Buffer.from(header.slice(8, 40));
        const decryptIv = Buffer.from(header.slice(40, 56));
        const reversed = Buffer.from(header.slice(8, 56)).reverse();
        const encryptKey = Buffer.from(reversed.slice(0, 32));
        const encryptIv = Buffer.from(reversed.slice(32, 48));
        // Server decrypts what client encrypts, and vice versa
        session.decryptor = new CTR(decryptKey, decryptIv);
        session.encryptor = new CTR(encryptKey, encryptIv);
        // Decrypt the full 64-byte header to advance CTR counter and verify tag
        const decryptedHeader = session.decryptor.decrypt(Buffer.from(header));
        const tag = decryptedHeader.slice(56, 60);
        const expectedTag = Buffer.from('efefefef', 'hex');
        if (!tag.equals(expectedTag)) {
            console.log(`[${new Date().toISOString()}] Session ${session.id} obfuscation tag: ${tag.toString('hex')} (expected efefefef)`);
        }
        session.obfuscated = true;
        session.handshakeComplete = true;
        // console.log(`[${new Date().toISOString()}] Session ${session.id} obfuscated transport initialized`);
        return { remaining: buffer.slice(64), response: Buffer.alloc(0) };
    }
    if (!session.decryptor) {
        console.log(`[${new Date().toISOString()}] Session ${session.id} no decryptor available`);
        return null;
    }
    // Step 2: Decrypt and parse abridged frames
    if (buffer.length < 1)
        return null;
    // If data was already decrypted (from previous iteration), use as-is
    const decrypted = preDecrypted ? buffer : session.decryptor.decrypt(Buffer.from(buffer));
    let msgLen;
    let headerLen;
    if (decrypted[0] >= 0x7f) {
        if (decrypted.length < 4)
            return null;
        msgLen = decrypted[1] | (decrypted[2] << 8) | (decrypted[3] << 16);
        headerLen = 4;
    }
    else {
        msgLen = decrypted[0];
        headerLen = 1;
    }
    msgLen = msgLen << 2;
    if (decrypted.length < headerLen + msgLen) {
        console.log(`[${new Date().toISOString()}] Session ${session.id} incomplete packet: have ${decrypted.length}, need ${headerLen + msgLen}`);
        return null;
    }
    const msgData = decrypted.slice(headerLen, headerLen + msgLen);
    const remaining = Buffer.from(decrypted.slice(headerLen + msgLen));
    // Check auth_key_id: 0 = unencrypted (auth), non-zero = encrypted
    const authKeyId = msgData.readBigInt64LE(0);
    if (authKeyId === 0n) {
        // Unencrypted message: auth_key_id(8) + msg_id(8) + length(4) = 20 bytes
        const innerPayload = msgData.length >= 20 ? msgData.slice(20) : msgData;
        const response = handleUnencryptedAuthPayload(innerPayload, session);
        return { remaining, response, preDecrypted: true };
    }
    // Encrypted message
    const response = handleEncryptedMessage(msgData, session);
    return { remaining, response, preDecrypted: true };
}
function handleUnencryptedAuthPayload(buffer, session) {
    const reader = new BinaryReader(buffer);
    const constructorId = reader.peekConstructorId();
    // console.log(`[${new Date().toISOString()}] Session ${session.id} received: 0x${constructorId.toString(16)}`);
    switch (constructorId) {
        case 0xbe7e8ef1: // req_pq_multi
        case 0x60469778: // req_pq (legacy)
            {
                const result = authHandler.processReqPqMultiSync(buffer, session.id);
                return createObfuscatedResponse(result, session);
            }
        case 0xd712e4be: { // ReqDHParams
            const result = authHandler.processReqDHParamsSync(buffer, session.id);
            return createObfuscatedResponse(result, session);
        }
        case 0xf5045f1f: { // set_client_DH_params
            const result = authHandler.processSetClientDHParamsSync(buffer, session.id);
            // Persist newly created auth key to SQLite
            for (const entry of authHandler.getAllAuthKeys()) {
                messageStore.saveAuthKey(entry.keyIdHex, entry.authKey);
            }
            return createObfuscatedResponse(result, session);
        }
        default:
            console.log(`Unknown auth payload: 0x${constructorId.toString(16)}`);
            return null;
    }
}
function createObfuscatedResponse(data, session) {
    const authKeyIdBuf = Buffer.alloc(8);
    const msgId = Buffer.alloc(8);
    msgId.writeBigInt64LE(generateMessageId(), 0);
    const msgLen = Buffer.alloc(4);
    msgLen.writeInt32LE(data.length, 0);
    const envelope = Buffer.concat([authKeyIdBuf, msgId, msgLen, data]);
    const length = envelope.length >> 2;
    let frame;
    if (length < 127) {
        frame = Buffer.concat([Buffer.from([length]), envelope]);
    }
    else {
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
function isServiceMessage(constructorId) {
    return (constructorId === 0xf3427b8c || // ping_delay_disconnect
        constructorId === 0x7abe77ec || // ping
        constructorId === 0x62d6b459 // msgs_ack
    );
}
function handleEncryptedMessage(data, session) {
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
    // Send new_session_created on first encrypted message for this session
    let newSessionMsg = null;
    if (!session.sentNewSessionCreated) {
        session.sentNewSessionCreated = true;
        const nsW = new BinaryWriter();
        nsW.writeInt(0x9ec20908); // new_session_created
        nsW.writeLong(messageId); // first_msg_id
        nsW.writeLong(BigInt(Date.now()) * 1000000n); // unique_id
        nsW.writeLong(serverSalt.readBigInt64LE(0)); // server_salt
        newSessionMsg = nsW.getBytes();
        console.log(`[${new Date().toISOString()}] Session ${session.id} sending new_session_created`);
    }
    // (verbose) encrypted msg log suppressed
    // Parse TL constructor from inner data
    const constructorId = innerData.readUInt32LE(0);
    // (verbose) inner constructor log suppressed
    // Handle msg_container
    if (constructorId === 0x73f1f8dc) {
        // IMPORTANT: encrypt and send new_session_created BEFORE the container,
        // so CTR cipher state advances in the same order as the send order.
        if (newSessionMsg) {
            const nsBuf = createEncryptedResponse(newSessionMsg, 0n, session, authKey);
            session.send?.(nsBuf);
        }
        const containerResp = handleMsgContainer(innerData, messageId, session, authKey);
        return containerResp;
    }
    // Service messages that should NOT be wrapped in rpc_result
    if (isServiceMessage(constructorId)) {
        const responseData = handleTlRequest(innerData, session, messageId, getHandlerCtx());
        if (newSessionMsg) {
            const nsBuf = createEncryptedResponse(newSessionMsg, 0n, session, authKey);
            session.send?.(nsBuf);
        }
        if (!responseData)
            return null;
        return createEncryptedResponse(responseData, messageId, session, authKey);
    }
    // RPC call: rate limit check
    if (!rpcLimiter.check(session.id)) {
        console.log(`[${new Date().toISOString()}] Session ${session.id} RATE LIMITED`);
        const floodError = buildRpcErrorObject(420, 'FLOOD_WAIT_30');
        if (newSessionMsg) {
            const nsBuf = createEncryptedResponse(newSessionMsg, 0n, session, authKey);
            session.send?.(nsBuf);
        }
        const rpcFlood = new BinaryWriter();
        rpcFlood.writeInt(0xf35c6d01);
        rpcFlood.writeLong(messageId);
        rpcFlood.writeBytes(floodError);
        return createEncryptedResponse(rpcFlood.getBytes(), messageId, session, authKey);
    }
    // RPC call: process and wrap in rpc_result
    let responseData = null;
    try {
        responseData = handleTlRequest(innerData, session, messageId, getHandlerCtx());
    }
    catch (err) {
        const cid = innerData.readUInt32LE(0);
        console.error(`[${new Date().toISOString()}] Session ${session.id} HANDLER ERROR for 0x${cid.toString(16)}:`, err);
        responseData = buildRpcErrorObject(500, 'INTERNAL_ERROR');
    }
    if (newSessionMsg) {
        const nsBuf = createEncryptedResponse(newSessionMsg, 0n, session, authKey);
        session.send?.(nsBuf);
    }
    if (!responseData)
        return null;
    const rpcResult = new BinaryWriter();
    rpcResult.writeInt(0xf35c6d01); // rpc_result constructor
    rpcResult.writeLong(messageId); // req_msg_id
    rpcResult.writeBytes(responseData);
    return createEncryptedResponse(rpcResult.getBytes(), messageId, session, authKey);
}
function handleMsgContainer(data, containerMsgId, session, authKey) {
    // msg_container#73f1f8dc count:int messages:...
    const count = data.readInt32LE(4);
    let offset = 8; // skip constructor(4) + count(4)
    const responses = [];
    for (let i = 0; i < count; i++) {
        if (offset + 16 > data.length)
            break;
        const msgId = data.readBigInt64LE(offset);
        offset += 8;
        const seqNo = data.readInt32LE(offset);
        offset += 4;
        const bodyLen = data.readInt32LE(offset);
        offset += 4;
        const body = data.slice(offset, offset + bodyLen);
        offset += bodyLen;
        const innerConstructor = body.readUInt32LE(0);
        // (verbose) container item log suppressed
        let responseData = null;
        try {
            responseData = handleTlRequest(body, session, msgId, getHandlerCtx());
        }
        catch (err) {
            console.error(`[${new Date().toISOString()}] Session ${session.id} HANDLER ERROR for 0x${innerConstructor.toString(16)}:`, err);
            responseData = buildRpcErrorObject(500, 'INTERNAL_ERROR');
        }
        if (responseData) {
            if (isServiceMessage(innerConstructor)) {
                // Service messages (ping, msgs_ack) — send response directly, no rpc_result
                responses.push(responseData);
            }
            else {
                const rpcResult = new BinaryWriter();
                rpcResult.writeInt(0xf35c6d01);
                rpcResult.writeLong(msgId);
                rpcResult.writeBytes(responseData);
                responses.push(rpcResult.getBytes());
            }
        }
    }
    if (responses.length === 0)
        return null;
    // Wrap all responses in a msg_container
    const containerW = new BinaryWriter();
    containerW.writeInt(0x73f1f8dc); // msg_container
    containerW.writeInt(responses.length);
    let baseMsgId = generateMessageId();
    for (const resp of responses) {
        containerW.writeLong(baseMsgId);
        baseMsgId += 4n; // ensure unique message IDs
        containerW.writeInt(1); // seqNo
        containerW.writeInt(resp.length);
        containerW.writeBytes(resp);
    }
    return createEncryptedResponse(containerW.getBytes(), containerMsgId, session, authKey);
}
function getHandlerCtx() {
    return { authKeyUserMap, broadcastToUser, broadcastSessionUpdates, removeAuthKey: (key) => authHandler.removeAuthKey(key) };
}
function createEncryptedResponse(responseData, reqMsgId, session, authKey) {
    // Build inner message
    const innerW = new BinaryWriter();
    innerW.writeBytes(session.serverSalt || Buffer.alloc(8)); // server_salt
    innerW.writeBytes(session.sessionId || Buffer.alloc(8)); // session_id
    // message_id (server response: must be slightly after request)  
    const respMsgId = generateMessageId();
    innerW.writeLong(respMsgId);
    innerW.writeInt(1); // seq_no (server, content-related = odd)
    innerW.writeInt(responseData.length); // message_data_length
    innerW.writeBytes(responseData);
    // Add padding (12-1024 bytes, total must be divisible by 16)
    const innerBytes = innerW.getBytes();
    let paddingLen = 12 + ((16 - ((innerBytes.length + 12) % 16)) % 16);
    if (paddingLen < 12)
        paddingLen += 16;
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
    let frame;
    if (length < 127) {
        frame = Buffer.concat([Buffer.from([length]), envelope]);
    }
    else {
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
function sendSessionUpdate(session, responseData) {
    if (!session.send) {
        return;
    }
    if (!session.serverSalt || !session.sessionId) {
        return;
    }
    const authKey = authHandler.getAuthKey(session.id);
    if (!authKey) {
        return;
    }
    session.send(createEncryptedResponse(responseData, 0n, session, authKey));
}
function broadcastSessionUpdates(sourceSession, responseData) {
    if (!responseData) {
        return;
    }
    const sourceUserId = sourceSession.userId || SEED_USER_ID;
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
function broadcastToUser(targetUserId, responseData, excludeSessionId) {
    if (!responseData)
        return;
    let sentCount = 0;
    for (const targetSession of clients.values()) {
        if (excludeSessionId && targetSession.id === excludeSessionId)
            continue;
        // Skip download sessions (no userId bound)
        if (!targetSession.userId)
            continue;
        if (targetSession.userId !== targetUserId)
            continue;
        sendSessionUpdate(targetSession, responseData);
        sentCount++;
    }
    if (sentCount > 0) {
        console.log(`[${new Date().toISOString()}] BroadcastToUser ${targetUserId}: ${responseData.length} bytes to ${sentCount} sessions`);
    }
}
//# sourceMappingURL=server.js.map