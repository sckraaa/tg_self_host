import { TLReader, TLWriter } from './tl.js';
import { IGE, sha256, generateRandomBytes } from '../crypto/utils.js';
const CONSTRUCTOR_IDS = {
    RES_PQ: 0x05162463,
    SERVER_DH_PARAMS_OK: 0xd0e6735e,
    SERVER_DH_PARAMS_FAIL: 0x79cb045d,
    CLIENT_DH_INNER_DATA: 0x55bc65f,
    SERVER_DH_INNER_DATA: 0xb58911d4,
    DH_GEN_OK: 0x3bcbf42f,
    DH_GEN_RETRY: 0x46a1d93,
    DH_GEN_FAIL: 0xa73d27,
    PQ_OUTER_DATA: 0x83c95e1e,
    INVOKE_WITH_LAYER: 0x935fe7a2,
    INIT_CONNECTION: 0xc1cd5b9a,
    INVOKE: 0x5a97b3e2,
    HTTP_WAIT: 0x9299359f,
};
export async function processMTProtoMessage(buffer, session) {
    const reader = new TLReader(buffer);
    try {
        const authKeyId = reader.readLong(false);
        if (authKeyId === 0n) {
            return processPlainMessage(buffer, session);
        }
        return await processEncryptedMessage(buffer, session);
    }
    catch (error) {
        console.error('MTProto message processing error:', error);
        return null;
    }
}
function processPlainMessage(buffer, session) {
    const reader = new TLReader(buffer);
    reader.readLong(false);
    const msgId = reader.readLong();
    const msgLength = reader.readInt(false);
    if (msgLength <= 0 || msgLength > buffer.length - reader.getOffset()) {
        return null;
    }
    const innerData = reader.readBytes(msgLength);
    const innerReader = new TLReader(innerData);
    try {
        const constructorId = innerReader.peekConstructorId();
        switch (constructorId) {
            case CONSTRUCTOR_IDS.PQ_OUTER_DATA:
                return handlePQInner(innerReader);
            default:
                console.log(`Unknown plain message constructor: 0x${constructorId.toString(16)}`);
                return null;
        }
    }
    catch {
        return null;
    }
}
function handlePQInner(reader) {
    const nonce = reader.readBytes(16);
    const serverNonce = reader.readBytes(32);
    const resPQ = new TLWriter();
    resPQ.writeInt(0x05162463);
    resPQ.writeBytes(nonce);
    resPQ.writeBytes(serverNonce);
    const pq = generateRandomBytes(8);
    resPQ.writeBytes(pq);
    resPQ.writeInt(1);
    resPQ.writeBytes(Buffer.from([0x01, 0x00]));
    resPQ.writeBytes(Buffer.from([0x01, 0x00]));
    resPQ.writeInt(0);
    const fingerprint = Buffer.alloc(8);
    fingerprint.writeBigInt64LE(0xc71caeb9c6b1c9048n, 0);
    resPQ.writeBytes(fingerprint);
    const padding = generateRandomBytes(256 - resPQ.getBytes().length);
    resPQ.writeBytes(padding);
    return resPQ.getBytes();
}
async function processEncryptedMessage(buffer, session) {
    if (!session.authKey || !session.authKeyId) {
        return createErrorRpc(401, 'AUTH_KEY_INVALID');
    }
    try {
        const decrypted = await decryptMessage(buffer, session.authKey);
        const reader = new TLReader(decrypted);
        reader.readLong(false);
        reader.readLong(false);
        const msgId = reader.readLong();
        const seqNo = reader.readInt();
        const bodyLen = reader.readInt();
        const body = reader.readBytes(bodyLen);
        return await handleEncryptedBody(body, session, msgId, seqNo);
    }
    catch (error) {
        console.error('Decryption error:', error);
        return createErrorRpc(404, 'AUTH_KEY_INVALID');
    }
}
async function decryptMessage(buffer, authKey) {
    const msgKey = buffer.slice(8, 24);
    const encryptedData = buffer.slice(24);
    const calculatedKey = await sha256(Buffer.concat([
        authKey.slice(96, 96 + 32),
        buffer.slice(8),
    ]));
    const key = calculatedKey.slice(0, 8);
    const iv = calculatedKey.slice(8, 24);
    const ige = new IGE(key, iv);
    return ige.decryptIge(encryptedData);
}
async function handleEncryptedBody(body, session, msgId, seqNo) {
    const reader = new TLReader(body);
    const constructorId = reader.peekConstructorId();
    switch (constructorId) {
        case CONSTRUCTOR_IDS.INVOKE:
            return await handleInvoke(reader, session, msgId, seqNo);
        case CONSTRUCTOR_IDS.INIT_CONNECTION:
            return await handleInitConnection(reader, session, msgId, seqNo);
        case CONSTRUCTOR_IDS.HTTP_WAIT:
            return createRpcResult(msgId, Buffer.from([0x997275b5]));
        default:
            console.log(`Unknown invoke constructor: 0x${constructorId.toString(16)}`);
            return null;
    }
}
async function handleInvoke(reader, session, msgId, seqNo) {
    reader.readInt();
    const queryLen = reader.readInt();
    const queryData = reader.readBytes(queryLen);
    return createRpcResult(msgId, Buffer.from([0x997275b5]));
}
async function handleInitConnection(reader, session, msgId, seqNo) {
    return createRpcResult(msgId, Buffer.from([0x997275b5]));
}
function createRpcResult(reqMsgId, result) {
    const writer = new TLWriter();
    writer.writeInt(0xf35c6d01);
    writer.writeLong(reqMsgId);
    writer.writeBytes(result);
    return writer.getBytes();
}
function createErrorRpc(errorCode, errorMessage) {
    const writer = new TLWriter();
    writer.writeInt(0xc4b9f9bb);
    writer.writeInt(errorCode);
    writer.writeString(errorMessage);
    return writer.getBytes();
}
//# sourceMappingURL=handler.js.map