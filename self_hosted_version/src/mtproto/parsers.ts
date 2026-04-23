import { BinaryReader } from './codec.js';
import { readTlString, readTlBytesRaw, skipInputPeer, parseInputReplyTo, skipTlVector, skipTlStringByReader } from './tlHelpers.js';
import type { ClientSession } from './server.js';
import { setCurrentSession, currentSession } from './requestContext.js';

// Re-exports so other modules can keep the old import path without churn.
// These are the ONLY places that should touch the global request context;
// everywhere else should thread `ClientSession` through as an explicit parameter.
export { setCurrentSession as setActiveSession, currentSession as getActiveSession };

// SEED_USER_ID re-exported for use in parsers
export const SEED_USER_ID = 100000;

// ========== Parsed types ==========

export type ParsedHistoryRequest = {
  peerKey: string;
  offsetId: number;
  limit: number;
};

export type ParsedSendMessageRequest = {
  peerKey: string;
  message: string;
  randomId: string;
  replyToMsgId?: number;
  quoteText?: string;
  quoteOffset?: number;
  entities?: ParsedMessageEntity[];
};

/**
 * TL MessageEntity variants stored in a normalized shape (audit #2).
 * `type` mirrors the TL constructor and serialization is lossy only for the
 * variants we do not yet implement on the client side.
 */
export type ParsedMessageEntity = {
  type: 'unknown' | 'mention' | 'hashtag' | 'botCommand' | 'url' | 'email'
    | 'bold' | 'italic' | 'code' | 'pre' | 'textUrl' | 'mentionName'
    | 'phone' | 'cashtag' | 'underline' | 'strike' | 'blockquote' | 'bankCard'
    | 'spoiler' | 'customEmoji';
  offset: number;
  length: number;
  url?: string;
  userId?: number;
  language?: string;
  documentId?: string;
  collapsed?: boolean;
};

export type ParsedSendMediaRequest = {
  peerKey: string;
  message: string;
  randomId: string;
  replyToMsgId?: number;
  quoteText?: string;
  quoteOffset?: number;
  mediaType: 'photo' | 'document';
  fileId: string;
  mimeType?: string;
  fileName?: string;
  // For documents: attributes parsed from InputMedia
  entities?: ParsedMessageEntity[];
  docAttributes?: Array<
    { type: 'imageSize'; w: number; h: number } |
    { type: 'filename'; name: string } |
    { type: 'audio'; voice: boolean; duration: number; title?: string; performer?: string; waveform?: Buffer }
  >;
};

export type ParsedReadHistoryRequest = {
  peerKey: string;
  maxId: number;
};

export type ParsedUpdatesDifferenceRequest = {
  pts: number;
};

export type ParsedChannelRef = {
  channelId: string;
};

export type ParsedUserRef = {
  userId: string;
};

export type ParsedPeerRef = {
  peerKey: string;
};

export interface ParsedSetTypingRequest {
  peerKey: string;
  actionConstructor: number;
}

export interface ParsedEditMessageRequest {
  peerKey: string;
  messageId: number;
  newText?: string;
  entities?: ParsedMessageEntity[];
}

export interface ParsedDeleteMessagesRequest {
  revoke: boolean;
  messageIds: number[];
}

export interface ParsedUploadProfilePhotoRequest {
  fileId?: string;
  targetUserId?: number;
}

// ========== InputPeer / InputUser readers ==========

/**
 * Resolve an InputPeer into a `<kind>:<id>` key.
 *
 * `session` is required to resolve `inputPeerSelf`. When the session is
 * unauthenticated (`session.userId` missing), `inputPeerSelf` returns
 * `undefined` instead of masquerading as the seed user — the caller should
 * surface that as `PEER_ID_INVALID` / `AUTH_KEY_UNREGISTERED` upstream.
 */
export function readInputPeerKey(reader: BinaryReader, session: ClientSession | undefined): string | undefined {
  const constructorId = reader.readInt() >>> 0;
  switch (constructorId) {
    case 0xdde8a54c: { // inputPeerUser
      const userId = reader.readLong().toString();
      reader.readLong(); // access_hash
      return `user:${userId}`;
    }
    case 0x35a95cb9: { // inputPeerChat
      return `chat:${reader.readLong().toString()}`;
    }
    case 0x27bcbbfc: { // inputPeerChannel
      const channelId = reader.readLong().toString();
      reader.readLong(); // access_hash
      return `channel:${channelId}`;
    }
    case 0x7da07ec9: { // inputPeerSelf
      const selfId = session?.userId;
      return selfId ? `user:${selfId}` : undefined;
    }
    default:
      return undefined;
  }
}

export function readInputDialogPeerKey(reader: BinaryReader, session: ClientSession | undefined): string | undefined {
  const constructorId = reader.readInt() >>> 0;
  switch (constructorId) {
    case 0xfcaafeb7: // inputDialogPeer
      return readInputPeerKey(reader, session);
    case 0x64600527: // inputDialogPeerFolder
      reader.readInt(); // folder_id
      return undefined;
    default:
      return undefined;
  }
}

export function readInputUserRef(reader: BinaryReader, session: ClientSession | undefined): ParsedUserRef | undefined {
  const constructorId = reader.readInt() >>> 0;
  switch (constructorId) {
    case 0xf21158c6: { // inputUser
      const userId = reader.readLong().toString();
      reader.readLong(); // access_hash
      return { userId };
    }
    case 0xf7c1b13f: { // inputUserSelf
      const selfId = session?.userId;
      return selfId ? { userId: String(selfId) } : undefined;
    }
    default:
      return undefined;
  }
}

// ========== Request parsers ==========

export function parseHistoryRequest(data: Buffer, session: ClientSession | undefined): ParsedHistoryRequest | undefined {
  const reader = new BinaryReader(data);
  reader.offset = 4; // skip constructor
  const peerKey = readInputPeerKey(reader, session);
  if (!peerKey) {
    return undefined;
  }

  const offsetId = reader.readInt();
  reader.readInt(); // offset_date
  reader.readInt(); // add_offset
  const limit = reader.readInt();

  return {
    peerKey,
    offsetId,
    limit,
  };
}

export function parseGetMessagesRequest(data: Buffer): number[] | undefined {
  // messages.getMessages#63c66506 id:Vector<InputMessage>
  const reader = new BinaryReader(data);
  reader.offset = 4; // skip constructor
  const vectorConstructor = reader.readInt() >>> 0;
  if (vectorConstructor !== 0x1cb5c415) {
    return undefined;
  }

  const count = reader.readInt();
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const inputMsgConstructor = reader.readInt() >>> 0;
    if (inputMsgConstructor === 0xa676a322) {
      // inputMessageID#a676a322 id:int
      ids.push(reader.readInt());
    } else if (inputMsgConstructor === 0x86872538) {
      // inputMessagePinned — skip
    } else if (inputMsgConstructor === 0xbad88395) {
      // inputMessageReplyTo#bad88395 id:int
      reader.readInt(); // skip id
    } else if (inputMsgConstructor === 0xacfa1571) {
      // inputMessageCallbackQuery#acfa1571 id:int query_id:long
      reader.readInt(); // skip id
      reader.readLong(); // skip query_id
    }
  }
  return ids;
}

export function parsePeerDialogsRequest(data: Buffer, session: ClientSession | undefined): string[] {
  try {
    const reader = new BinaryReader(data);
    reader.readInt(); // constructor id
    const vectorId = reader.readInt() >>> 0;
    if (vectorId !== 0x1cb5c415) return [];
    const count = reader.readInt();
    const peerKeys: string[] = [];
    for (let i = 0; i < count; i++) {
      const inputDialogPeerCtor = reader.readInt() >>> 0;
      if (inputDialogPeerCtor === 0xfcaafeb7) { // inputDialogPeer
        const key = readInputPeerKey(reader, session);
        if (key) peerKeys.push(key);
      } else if (inputDialogPeerCtor === 0x64600527) { // inputDialogPeerFolder
        reader.readInt(); // folder_id
      }
    }
    return peerKeys;
  } catch (e) {
    console.error('Failed to parse getPeerDialogs request:', (e as Error).message);
    return [];
  }
}

export function parseSetTypingRequest(data: Buffer, session: ClientSession | undefined): ParsedSetTypingRequest | undefined {
  try {
    const reader = new BinaryReader(data);
    reader.readInt(); // skip constructor
    const flags = reader.readInt();
    const peerKey = readInputPeerKey(reader, session);
    if (!peerKey) return undefined;
    // top_msg_id is flags.0
    if (flags & 1) reader.readInt();
    const actionConstructor = reader.readInt() >>> 0;
    return { peerKey, actionConstructor };
  } catch {
    return undefined;
  }
}

export function parseEditMessageRequest(data: Buffer, session: ClientSession | undefined): ParsedEditMessageRequest | undefined {
  try {
    // messages.editMessage#51e842e1 flags:# no_webpage:flags.1?true invert_media:flags.16?true
    //   peer:InputPeer id:int message:flags.11?string media:flags.14?InputMedia
    //   reply_markup:flags.2?ReplyMarkup entities:flags.3?Vector<MessageEntity> ...
    const reader = new BinaryReader(data);
    reader.readInt(); // skip constructor
    const flags = reader.readInt();
    const peerKey = readInputPeerKey(reader, session);
    if (!peerKey) return undefined;
    const messageId = reader.readInt();
    const newText = (flags & (1 << 11)) ? readTlString(reader) : undefined;
    // media flags.14 — we don't support editing media payloads yet; if this
    // bit ever gets set by the client we'll bail out of the entity parse
    // rather than read into the wrong slot.
    if ((flags & (1 << 14)) !== 0) {
      return { peerKey, messageId, newText };
    }
    if ((flags & (1 << 2)) !== 0) {
      skipReplyMarkup(reader);
    }
    let entities: ParsedMessageEntity[] | undefined;
    if ((flags & (1 << 3)) !== 0) {
      entities = readMessageEntitiesVector(reader);
    }
    return { peerKey, messageId, newText, entities };
  } catch {
    return undefined;
  }
}

export function parseDeleteMessagesRequest(data: Buffer): ParsedDeleteMessagesRequest | undefined {
  try {
    const reader = new BinaryReader(data);
    reader.readInt(); // skip constructor
    const flags = reader.readInt();
    const revoke = !!(flags & 1);
    const vectorId = reader.readInt() >>> 0;
    if (vectorId !== 0x1cb5c415) return undefined;
    const count = reader.readInt();
    const messageIds: number[] = [];
    for (let i = 0; i < count; i++) {
      messageIds.push(reader.readInt());
    }
    return { revoke, messageIds };
  } catch {
    return undefined;
  }
}

export function parseReadHistoryRequest(data: Buffer, session: ClientSession | undefined): ParsedReadHistoryRequest | undefined {
  const reader = new BinaryReader(data);
  reader.offset = 4; // skip constructor
  const peerKey = readInputPeerKey(reader, session);
  if (!peerKey) {
    return undefined;
  }

  return {
    peerKey,
    maxId: reader.readInt(),
  };
}

export function parseUpdatesDifferenceRequest(data: Buffer): ParsedUpdatesDifferenceRequest | undefined {
  const constructorId = data.readUInt32LE(0);
  const reader = new BinaryReader(data);
  reader.offset = 4; // skip constructor
  if (constructorId === 0x25d218ec) {
    return {
      pts: reader.readInt(),
    };
  }

  const flags = reader.readInt() >>> 0;
  const pts = reader.readInt();
  if (flags & (1 << 1)) {
    reader.readInt(); // pts_limit
  }
  if (flags & (1 << 0)) {
    reader.readInt(); // pts_total_limit
  }

  return { pts };
}

export function parseChannelReadHistoryRequest(data: Buffer): ParsedReadHistoryRequest | undefined {
  const reader = new BinaryReader(data);
  reader.offset = 4; // skip constructor
  const constructorId = reader.readInt() >>> 0;
  if (constructorId !== 0x27bcbbfc) { // inputChannel
    return undefined;
  }

  const channelId = reader.readLong().toString();
  reader.readLong(); // access_hash

  return {
    peerKey: `channel:${channelId}`,
    maxId: reader.readInt(),
  };
}

export function parseGetFullChannelRequest(data: Buffer): ParsedChannelRef | undefined {
  const reader = new BinaryReader(data);
  reader.offset = 4; // skip constructor
  const constructorId = reader.readInt() >>> 0;
  if (constructorId !== 0x27bcbbfc) { // inputChannel
    return undefined;
  }

  return {
    channelId: reader.readLong().toString(),
  };
}

export function parseGetFullUserRequest(data: Buffer, session?: ClientSession): ParsedUserRef | undefined {
  const reader = new BinaryReader(data);
  reader.offset = 4; // skip constructor
  return readInputUserRef(reader, session);
}

export function parseGetUsersRequest(data: Buffer, session?: ClientSession): ParsedUserRef[] | undefined {
  const reader = new BinaryReader(data);
  reader.offset = 4; // skip constructor
  const vectorConstructor = reader.readInt() >>> 0;
  if (vectorConstructor !== 0x1cb5c415) {
    return undefined;
  }

  const count = reader.readInt();
  const users: ParsedUserRef[] = [];
  for (let index = 0; index < count; index++) {
    const user = readInputUserRef(reader, session);
    if (user) {
      users.push(user);
    }
  }

  return users;
}

export function parsePeerVectorRequest(data: Buffer, session: ClientSession | undefined): ParsedPeerRef[] | undefined {
  const reader = new BinaryReader(data);
  reader.offset = 4; // skip constructor
  const vectorConstructor = reader.readInt() >>> 0;
  if (vectorConstructor !== 0x1cb5c415) {
    return undefined;
  }

  const count = reader.readInt();
  const peers: ParsedPeerRef[] = [];
  for (let index = 0; index < count; index++) {
    const peerKey = readInputPeerKey(reader, session);
    if (peerKey) {
      peers.push({ peerKey });
    }
  }

  return peers;
}

export function parseSendMessageRequest(data: Buffer, session: ClientSession | undefined): ParsedSendMessageRequest | undefined {
  try {
    const reader = new BinaryReader(data);
    reader.offset = 4; // skip constructor
    const flags = reader.readInt() >>> 0;

    const peerKey = readInputPeerKey(reader, session);
    if (!peerKey) {
      return undefined;
    }

    // Parse reply_to:flags.0?InputReplyTo if present
    let replyToMsgId: number | undefined;
    let quoteText: string | undefined;
    let quoteOffset: number | undefined;
    if ((flags & (1 << 0)) !== 0) {
      const replyTo = parseInputReplyTo(reader);
      replyToMsgId = replyTo?.replyToMsgId;
      quoteText = replyTo?.quoteText;
      quoteOffset = replyTo?.quoteOffset;
    }

    const message = readTlString(reader);
    const randomId = reader.readLong(false).toString();

    // reply_markup flags.2
    if ((flags & (1 << 2)) !== 0) {
      // skip ReplyMarkup — any constructor + flags + rows
      skipReplyMarkup(reader);
    }

    // entities flags.3? Vector<MessageEntity>
    let entities: ParsedMessageEntity[] | undefined;
    if ((flags & (1 << 3)) !== 0) {
      entities = readMessageEntitiesVector(reader);
    }

    return {
      peerKey,
      message,
      randomId,
      replyToMsgId,
      quoteText,
      quoteOffset,
      entities,
    };
  } catch (e) {
    console.log(`[WARN] parseSendMessageRequest: parse error:`, (e as Error).message);
    return undefined;
  }
}

/**
 * Read a `Vector<MessageEntity>` from the TL stream (audit #2).
 *
 * Unknown entity constructors are skipped as best-effort: TL doesn't give us
 * an object length, so we advance the offset to end of buffer only if we
 * cannot identify the constructor. This is good enough for the web client which
 * only sends a small well-known subset.
 */
export function readMessageEntitiesVector(reader: BinaryReader): ParsedMessageEntity[] {
  const vecCid = reader.readInt() >>> 0;
  if (vecCid !== 0x1cb5c415) return [];
  const count = reader.readInt();
  const entities: ParsedMessageEntity[] = [];
  for (let i = 0; i < count; i++) {
    const cid = reader.readInt() >>> 0;
    switch (cid) {
      case 0xfa04579d: // messageEntityMention
        entities.push({ type: 'mention', offset: reader.readInt(), length: reader.readInt() }); break;
      case 0x6f635b0d: // messageEntityHashtag
        entities.push({ type: 'hashtag', offset: reader.readInt(), length: reader.readInt() }); break;
      case 0x6cef8ac7: // messageEntityBotCommand
        entities.push({ type: 'botCommand', offset: reader.readInt(), length: reader.readInt() }); break;
      case 0x6ed02538: // messageEntityUrl
        entities.push({ type: 'url', offset: reader.readInt(), length: reader.readInt() }); break;
      case 0x64e475c2: // messageEntityEmail
        entities.push({ type: 'email', offset: reader.readInt(), length: reader.readInt() }); break;
      case 0xbd610bc9: // messageEntityBold
        entities.push({ type: 'bold', offset: reader.readInt(), length: reader.readInt() }); break;
      case 0x826f8b60: // messageEntityItalic
        entities.push({ type: 'italic', offset: reader.readInt(), length: reader.readInt() }); break;
      case 0x28a20571: // messageEntityCode
        entities.push({ type: 'code', offset: reader.readInt(), length: reader.readInt() }); break;
      case 0x73924be0: { // messageEntityPre
        const offset = reader.readInt();
        const length = reader.readInt();
        const language = readTlString(reader);
        entities.push({ type: 'pre', offset, length, language });
        break;
      }
      case 0x76a6d327: { // messageEntityTextUrl
        const offset = reader.readInt();
        const length = reader.readInt();
        const url = readTlString(reader);
        entities.push({ type: 'textUrl', offset, length, url });
        break;
      }
      case 0xdc7b1140: { // messageEntityMentionName
        const offset = reader.readInt();
        const length = reader.readInt();
        const userId = Number(reader.readLong(false));
        entities.push({ type: 'mentionName', offset, length, userId });
        break;
      }
      case 0x208e68c9: { // inputMessageEntityMentionName (incoming only)
        const offset = reader.readInt();
        const length = reader.readInt();
        // InputUser — skip its concrete variant; currently only InputUser#f21158c6 has body
        const iuCid = reader.readInt() >>> 0;
        let userId = 0;
        if (iuCid === 0xf21158c6) {
          userId = Number(reader.readLong(false));
          reader.readLong(false); // access_hash
        }
        entities.push({ type: 'mentionName', offset, length, userId });
        break;
      }
      case 0x9b69e34b: // messageEntityPhone
        entities.push({ type: 'phone', offset: reader.readInt(), length: reader.readInt() }); break;
      case 0x4c4e743f: // messageEntityCashtag
        entities.push({ type: 'cashtag', offset: reader.readInt(), length: reader.readInt() }); break;
      case 0x9c4e7e8b: // messageEntityUnderline
        entities.push({ type: 'underline', offset: reader.readInt(), length: reader.readInt() }); break;
      case 0xbf0693d4: // messageEntityStrike
        entities.push({ type: 'strike', offset: reader.readInt(), length: reader.readInt() }); break;
      case 0xf1ccaaac: { // messageEntityBlockquote flags:# collapsed:flags.0?true offset:int length:int
        const eflags = reader.readInt() >>> 0;
        entities.push({
          type: 'blockquote',
          offset: reader.readInt(),
          length: reader.readInt(),
          collapsed: !!(eflags & (1 << 0)),
        });
        break;
      }
      case 0x761e6af4: // messageEntityBankCard
        entities.push({ type: 'bankCard', offset: reader.readInt(), length: reader.readInt() }); break;
      case 0x32ca960f: // messageEntitySpoiler
        entities.push({ type: 'spoiler', offset: reader.readInt(), length: reader.readInt() }); break;
      case 0xc8cf05f8: { // messageEntityCustomEmoji
        const offset = reader.readInt();
        const length = reader.readInt();
        const documentId = reader.readLong(false).toString();
        entities.push({ type: 'customEmoji', offset, length, documentId });
        break;
      }
      default:
        // Unknown — skip offset+length as best-effort (most entity variants
        // begin with offset:int length:int). If this breaks the stream the
        // caller's try/catch will bail out and we'll return undefined.
        console.log(`[WARN] readMessageEntitiesVector: unknown constructor 0x${cid.toString(16)}`);
        reader.readInt();
        reader.readInt();
        break;
    }
  }
  return entities;
}

/**
 * Augment entities with server-side auto-detected URLs / emails (audit follow-up).
 *
 * Real Telegram auto-linkifies plain URLs/emails that don't already have an
 * entity covering them, so the client can render them as clickable. Without
 * this, messages like "see https://example.com" arrive as plain text because
 * the web client only emits `messageEntityTextUrl` for entries it formatted
 * itself (Ctrl+K), never `messageEntityUrl` for typed URLs.
 *
 * Offsets here are in UTF-16 code units to match the TL convention used by
 * MessageEntity — that matches JavaScript's native string indexing.
 */
export function autoDetectUrlEntities(
  text: string,
  existing: ParsedMessageEntity[] | undefined,
): ParsedMessageEntity[] | undefined {
  if (!text) return existing;
  const result: ParsedMessageEntity[] = existing ? [...existing] : [];

  const covered = (offset: number, length: number): boolean =>
    result.some(e => offset < e.offset + e.length && e.offset < offset + length);

  // URL regex: http(s)://host[/path]. Kept intentionally conservative so we
  // don't grab trailing punctuation like "," or "." into the link.
  const urlRe = /\bhttps?:\/\/[^\s<>"'`)\]}]+[^\s<>"'`)\]}.,!?;:]/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(text))) {
    const offset = m.index;
    const length = m[0].length;
    if (!covered(offset, length)) {
      result.push({ type: 'url', offset, length });
    }
  }

  // Emails
  const emailRe = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;
  while ((m = emailRe.exec(text))) {
    const offset = m.index;
    const length = m[0].length;
    if (!covered(offset, length)) {
      result.push({ type: 'email', offset, length });
    }
  }

  // Mentions (@username) — only when not already covered by mentionName.
  const mentionRe = /(^|[^\w])@([a-zA-Z][a-zA-Z0-9_]{3,31})\b/g;
  while ((m = mentionRe.exec(text))) {
    const offset = m.index + m[1].length; // skip leading non-word char
    const length = m[2].length + 1;        // include '@'
    if (!covered(offset, length)) {
      result.push({ type: 'mention', offset, length });
    }
  }

  // Hashtags (#tag)
  const hashtagRe = /(^|[^\w])#([\p{L}\p{N}_]{1,64})\b/gu;
  while ((m = hashtagRe.exec(text))) {
    const offset = m.index + m[1].length;
    const length = m[2].length + 1;
    if (!covered(offset, length)) {
      result.push({ type: 'hashtag', offset, length });
    }
  }

  if (!existing && result.length === 0) return undefined;
  // Stable-sort by offset so serialized order matches text order (some clients care).
  result.sort((a, b) => a.offset - b.offset);
  return result;
}

function skipReplyMarkup(reader: BinaryReader): void {
  // ReplyKeyboardHide#a03e5b85 / ForceReply#86b40b08 / ReplyKeyboardMarkup#85dd99d1 /
  // ReplyInlineMarkup#48a30254 / ReplyKeyboardForceReply/… - all have a small flags prefix
  // and rows of buttons. Robust skipping is too much work; we read the constructor and
  // assume the remaining bytes are for the caller's error path.
  const cid = reader.readInt() >>> 0;
  // All four variants start with flags:int
  reader.readInt();
  if (cid === 0x85dd99d1 || cid === 0x48a30254) {
    // rows:Vector<KeyboardButtonRow>
    const vec = reader.readInt() >>> 0;
    if (vec === 0x1cb5c415) {
      const rowCount = reader.readInt();
      for (let i = 0; i < rowCount; i++) {
        reader.readInt(); // KeyboardButtonRow constructor
        const btnVec = reader.readInt() >>> 0;
        if (btnVec !== 0x1cb5c415) return;
        const btnCount = reader.readInt();
        for (let j = 0; j < btnCount; j++) {
          reader.readInt(); // button constructor
          skipTlStringByReader(reader); // text
        }
      }
    }
    if (cid === 0x85dd99d1) {
      // placeholder:flags.3?string
      // Too ambiguous to skip generically — let the caller ignore trailing bytes.
    }
  }
}

function parseInputFile(reader: BinaryReader): { fileId: string; fileName: string } | undefined {
  const cid = reader.readInt() >>> 0;
  if (cid === 0xf52ff27f) { // inputFile
    const id = reader.readLong(false).toString();
    reader.readInt(); // parts
    const name = readTlString(reader);
    readTlString(reader); // md5_checksum
    return { fileId: id, fileName: name };
  } else if (cid === 0xfa4f0bb5) { // inputFileBig
    const id = reader.readLong(false).toString();
    reader.readInt(); // parts
    const name = readTlString(reader);
    return { fileId: id, fileName: name };
  }
  return undefined;
}

export function parseSendMediaRequest(data: Buffer, session: ClientSession | undefined): ParsedSendMediaRequest | undefined {
  try {
    const reader = new BinaryReader(data);
    reader.offset = 4; // skip constructor
    const flags = reader.readInt() >>> 0;

    const peerKey = readInputPeerKey(reader, session);
    if (!peerKey) return undefined;

    // reply_to:flags.0?InputReplyTo
    let replyToMsgId: number | undefined;
    let quoteText: string | undefined;
    let quoteOffset: number | undefined;
    if ((flags & (1 << 0)) !== 0) {
      const replyTo = parseInputReplyTo(reader);
      replyToMsgId = replyTo?.replyToMsgId;
      quoteText = replyTo?.quoteText;
      quoteOffset = replyTo?.quoteOffset;
    }

    // media:InputMedia
    const mediaCid = reader.readInt() >>> 0;
    let mediaType: 'photo' | 'document';
    let fileId: string | undefined;
    let mimeType: string | undefined;
    let fileName: string | undefined;
    const docAttributes: ParsedSendMediaRequest['docAttributes'] = [];

    if (mediaCid === 0x1e287d04) { // inputMediaUploadedPhoto
      mediaType = 'photo';
      const mediaFlags = reader.readInt() >>> 0;
      const inputFile = parseInputFile(reader);
      if (!inputFile) return undefined;
      fileId = inputFile.fileId;
      fileName = inputFile.fileName;
      // stickers:flags.0?Vector<InputDocument>
      if (mediaFlags & (1 << 0)) {
        skipTlVector(reader);
      }
      // ttl_seconds:flags.1?int
      if (mediaFlags & (1 << 1)) reader.readInt();
    } else if (mediaCid === 0x5b38c6c1 || mediaCid === 0x037c9330) { // inputMediaUploadedDocument (npm + web client)
      mediaType = 'document';
      const mediaFlags = reader.readInt() >>> 0;
      const inputFile = parseInputFile(reader);
      if (!inputFile) return undefined;
      fileId = inputFile.fileId;
      fileName = inputFile.fileName;
      // thumb:flags.2?InputFile
      if (mediaFlags & (1 << 2)) {
        parseInputFile(reader); // skip thumb
      }
      mimeType = readTlString(reader);
      // attributes:Vector<DocumentAttribute>
      const attrVecCid = reader.readInt() >>> 0;
      if (attrVecCid === 0x1cb5c415) {
        const attrCount = reader.readInt();
        for (let i = 0; i < attrCount; i++) {
          const attrCid = reader.readInt() >>> 0;
          if (attrCid === 0x6c37c15c) { // documentAttributeImageSize
            const w = reader.readInt();
            const h = reader.readInt();
            docAttributes.push({ type: 'imageSize', w, h });
          } else if (attrCid === 0x15590068) { // documentAttributeFilename
            const name = readTlString(reader);
            docAttributes.push({ type: 'filename', name });
            if (!fileName || fileName === 'upload') fileName = name;
          } else if (attrCid === 0x6319d612) { // documentAttributeHasStickers
            // no fields
          } else if (attrCid === 0x0ef02ce6) { // documentAttributeAnimated
            // no fields
          } else if (attrCid === 0x9852f9c6) { // documentAttributeAudio
            const audioFlags = reader.readInt() >>> 0;
            const voice = !!(audioFlags & (1 << 10));
            const duration = reader.readInt();
            const title = (audioFlags & (1 << 0)) ? readTlString(reader) : undefined;
            const performer = (audioFlags & (1 << 1)) ? readTlString(reader) : undefined;
            const waveform = (audioFlags & (1 << 2)) ? readTlBytesRaw(reader) : undefined;
            docAttributes.push({ type: 'audio', voice, duration, title, performer, waveform });
          } else if (attrCid === 0x17399fad) { // documentAttributeVideo (newer)
            const videoFlags = reader.readInt() >>> 0;
            reader.readLong(); // duration (double stored as 8 bytes)
            const w = reader.readInt();
            const h = reader.readInt();
            docAttributes.push({ type: 'imageSize', w, h });
            if (videoFlags & (1 << 4)) reader.readInt(); // preload_prefix_size
            if (videoFlags & (1 << 6)) reader.readLong(); // video_start_ts (double)
            if (videoFlags & (1 << 7)) skipTlStringByReader(reader); // video_codec (string)
          } else {
            // Unknown attribute, try to skip: best effort
            break;
          }
        }
      }
      // nosound_video, force_file, ttl_seconds, stickers, spoiler, video_cover, video_timestamp
      // We don't need to parse these for our purposes
    } else {
      console.log(`[WARN] parseSendMediaRequest: unsupported InputMedia constructor 0x${mediaCid.toString(16)}`);
      return undefined;
    }

    if (!fileId) return undefined;

    // message:string
    const message = readTlString(reader);
    // random_id:long
    const randomId = reader.readLong(false).toString();

    // reply_markup:flags.2?ReplyMarkup
    if ((flags & (1 << 2)) !== 0) {
      skipReplyMarkup(reader);
    }
    // entities:flags.3?Vector<MessageEntity> — caption formatting
    let entities: ParsedMessageEntity[] | undefined;
    if ((flags & (1 << 3)) !== 0) {
      entities = readMessageEntitiesVector(reader);
    }

    return {
      peerKey,
      message,
      randomId,
      replyToMsgId,
      quoteText,
      quoteOffset,
      mediaType,
      fileId,
      mimeType,
      fileName,
      entities,
      docAttributes: docAttributes.length > 0 ? docAttributes : undefined,
    };
  } catch (e) {
    console.log(`[WARN] parseSendMediaRequest: parse error:`, (e as Error).message);
    return undefined;
  }
}

export function parseForwardMessagesRequest(data: Buffer, session: ClientSession): { fromPeerKey: string | undefined; toPeerKey: string | undefined; messageIds: number[]; randomIds: string[]; dropAuthor: boolean; dropMediaCaptions: boolean } | undefined {
  try {
    const reader = new BinaryReader(data);
    reader.offset = 4; // skip constructor
    const flags = reader.readInt() >>> 0;
    const dropAuthor = !!(flags & (1 << 11));
    const dropMediaCaptions = !!(flags & (1 << 12));
    console.log(`[FWD-PARSE] flags=0x${flags.toString(16)} (${flags}) dropAuthor=${dropAuthor} dropMediaCaptions=${dropMediaCaptions}`);

    // from_peer: InputPeer
    const fromPeerKey = readInputPeerKey(reader, session);

    // id: Vector<int>
    const vectorCid = reader.readInt() >>> 0;
    const idCount = reader.readInt();
    const messageIds: number[] = [];
    for (let i = 0; i < idCount; i++) {
      messageIds.push(reader.readInt());
    }

    // random_id: Vector<long>
    const rVectorCid = reader.readInt() >>> 0;
    const rCount = reader.readInt();
    const randomIds: string[] = [];
    for (let i = 0; i < rCount; i++) {
      randomIds.push(reader.readLong(false).toString());
    }

    // to_peer: InputPeer
    const toPeerKey = readInputPeerKey(reader, session);

    return { fromPeerKey, toPeerKey, messageIds, randomIds, dropAuthor, dropMediaCaptions };
  } catch (e) {
    console.log(`[WARN] parseForwardMessagesRequest: parse error:`, (e as Error).message);
    return undefined;
  }
}

// ========== messages.search parser ==========

export interface ParsedSearchRequest {
  peerKey?: string;
  query: string;
  filterType: 'empty' | 'photos' | 'video' | 'photo_video' | 'document' | 'url' | 'gif' | 'voice' | 'music' | 'pinned' | 'chat_photos' | 'other';
  minDate: number;
  maxDate: number;
  offsetId: number;
  addOffset: number;
  limit: number;
  maxId: number;
  minId: number;
}

const FILTER_MAP: Record<number, ParsedSearchRequest['filterType']> = {
  0x57e2f66c: 'empty',
  0x9609a51c: 'photos',
  0x9fc00e65: 'video',
  0x56e9f0e4: 'photo_video',
  0x9eddf188: 'document',
  0x7ef0dd87: 'url',
  0xffc86587: 'gif',
  0x50f5c392: 'voice',
  0x3751b49e: 'music',
  0x1bb00451: 'pinned',
  0x3a20ecb8: 'chat_photos',
};

export function parseSearchRequest(data: Buffer, session: ClientSession | undefined): ParsedSearchRequest | undefined {
  try {
    const reader = new BinaryReader(data);
    reader.offset = 4; // skip constructor

    const flags = reader.readInt();

    // peer: InputPeer
    const peerKey = readInputPeerKey(reader, session);

    // q: string
    const query = readTlString(reader);

    // from_id: flags.0? InputPeer
    if (flags & (1 << 0)) {
      skipInputPeer(reader);
    }

    // saved_peer_id: flags.2? InputPeer
    if (flags & (1 << 2)) {
      skipInputPeer(reader);
    }

    // saved_reaction: flags.3? Vector<Reaction>
    if (flags & (1 << 3)) {
      skipTlVector(reader);
    }

    // top_msg_id: flags.1? int
    if (flags & (1 << 1)) {
      reader.readInt();
    }

    // filter: MessagesFilter
    const filterCid = reader.readInt() >>> 0;
    // inputMessagesFilterPhoneCalls has flags subfield
    if (filterCid === 0x80c99768) {
      reader.readInt(); // flags for phone calls filter
    }
    const filterType = FILTER_MAP[filterCid] || 'other';

    const minDate = reader.readInt();
    const maxDate = reader.readInt();
    const offsetId = reader.readInt();
    const addOffset = reader.readInt();
    const limit = reader.readInt();
    const maxId = reader.readInt();
    const minId = reader.readInt();

    return { peerKey, query, filterType, minDate, maxDate, offsetId, addOffset, limit, maxId, minId };
  } catch (e) {
    console.log(`[WARN] parseSearchRequest: parse error:`, (e as Error).message);
    return undefined;
  }
}

// messages.searchGlobal#4bc6589a flags:# broadcasts_only:flags.1?true groups_only:flags.2?true
//   users_only:flags.3?true folder_id:flags.0?int q:string filter:MessagesFilter
//   min_date:int max_date:int offset_rate:int offset_peer:InputPeer offset_id:int limit:int
export interface ParsedSearchGlobalRequest {
  query: string;
  filterType: ParsedSearchRequest['filterType'];
  minDate: number;
  maxDate: number;
  offsetId: number;
  limit: number;
  broadcastsOnly: boolean;
  groupsOnly: boolean;
  usersOnly: boolean;
}

export function parseSearchGlobalRequest(data: Buffer): ParsedSearchGlobalRequest | undefined {
  try {
    const reader = new BinaryReader(data);
    reader.offset = 4; // skip constructor

    const flags = reader.readInt();
    const broadcastsOnly = !!(flags & (1 << 1));
    const groupsOnly = !!(flags & (1 << 2));
    const usersOnly = !!(flags & (1 << 3));

    // folder_id: flags.0? int
    if (flags & (1 << 0)) {
      reader.readInt();
    }

    // q: string
    const query = readTlString(reader);

    // filter: MessagesFilter
    const filterCid = reader.readInt() >>> 0;
    if (filterCid === 0x80c99768) {
      reader.readInt(); // inputMessagesFilterPhoneCalls flags
    }
    const filterType = FILTER_MAP[filterCid] || 'other';

    const minDate = reader.readInt();
    const maxDate = reader.readInt();
    const offsetRate = reader.readInt();

    // offset_peer: InputPeer — skip
    skipInputPeer(reader);

    const offsetId = reader.readInt();
    const limit = reader.readInt();

    return { query, filterType, minDate, maxDate, offsetId, limit, broadcastsOnly, groupsOnly, usersOnly };
  } catch (e) {
    console.log(`[WARN] parseSearchGlobalRequest: parse error:`, (e as Error).message);
    return undefined;
  }
}

// ========== messages.createChat parser ==========

export interface ParsedCreateChatRequest {
  userIds: number[];
  userAccessHashes: bigint[];
  title: string;
}

export function parseCreateChatRequest(data: Buffer): ParsedCreateChatRequest | undefined {
  try {
    const reader = new BinaryReader(data);
    reader.offset = 4; // skip constructor
    const flags = reader.readInt();

    // users: Vector<InputUser>
    const _vecCid = reader.readInt() >>> 0; // vector constructor
    const userCount = reader.readInt();
    const userIds: number[] = [];
    const userAccessHashes: bigint[] = [];
    for (let i = 0; i < userCount; i++) {
      const userCid = reader.readInt() >>> 0;
      if (userCid === 0xf7c1b13f) {
        // inputUserSelf
        // resolved in handler
        userIds.push(-1); // sentinel for self
        userAccessHashes.push(0n);
      } else if (userCid === 0xf21158c6) {
        // inputUser#f21158c6 user_id:long access_hash:long
        userIds.push(Number(reader.readLong(false)));
        userAccessHashes.push(reader.readLong(false));
      } else {
        // inputUserEmpty or unknown
        userIds.push(0);
        userAccessHashes.push(0n);
      }
    }

    // title: string
    const title = readTlString(reader);

    // ttl_period: flags.0? int
    if (flags & (1 << 0)) {
      reader.readInt();
    }

    return { userIds, userAccessHashes, title };
  } catch (e) {
    console.log(`[WARN] parseCreateChatRequest: parse error:`, (e as Error).message);
    return undefined;
  }
}

// ========== channels.createChannel parser ==========

export interface ParsedCreateChannelRequest {
  isBroadcast: boolean;
  isMegagroup: boolean;
  title: string;
  about: string;
}

export function parseCreateChannelRequest(data: Buffer): ParsedCreateChannelRequest | undefined {
  try {
    const reader = new BinaryReader(data);
    reader.offset = 4; // skip constructor
    const flags = reader.readInt();
    const isBroadcast = !!(flags & (1 << 0));
    const isMegagroup = !!(flags & (1 << 1));

    // title: string
    const title = readTlString(reader);

    // about: string
    const about = readTlString(reader);

    return { isBroadcast, isMegagroup, title, about };
  } catch (e) {
    console.log(`[WARN] parseCreateChannelRequest: parse error:`, (e as Error).message);
    return undefined;
  }
}

// ========== messages.saveDraft parser ==========

export interface ParsedSaveDraftRequest {
  peerKey: string | undefined;
  message: string;
  replyToMsgId?: number;
}

export function parseSaveDraftRequest(data: Buffer, session: ClientSession | undefined): ParsedSaveDraftRequest | undefined {
  try {
    const reader = new BinaryReader(data);
    reader.offset = 4; // skip constructor
    const flags = reader.readInt();
    // no_webpage: flags.1 (true flag, skip)
    // invert_media: flags.6 (true flag, skip)

    // reply_to: flags.4? InputReplyTo
    let replyToMsgId: number | undefined;
    if (flags & (1 << 4)) {
      const replyToCid = reader.readInt() >>> 0;
      if (replyToCid === 0x22c0f6d5) {
        // inputReplyToMessage#22c0f6d5 flags:# reply_to_msg_id:int ...
        const rtFlags = reader.readInt();
        replyToMsgId = reader.readInt();
        // top_msg_id: flags.0? int
        if (rtFlags & (1 << 0)) reader.readInt();
        // reply_to_peer_id: flags.1? InputPeer
        if (rtFlags & (1 << 1)) skipInputPeer(reader);
        // quote_text: flags.2? string
        if (rtFlags & (1 << 2)) readTlString(reader);
        // quote_entities: flags.3? Vector<MessageEntity>
        if (rtFlags & (1 << 3)) {
          const _cid = reader.readInt();
          const cnt = reader.readInt();
          for (let i = 0; i < cnt; i++) {
            // skip entity — variable size, just hope it works
          }
        }
        // quote_offset: flags.4? int
        if (rtFlags & (1 << 4)) reader.readInt();
      } else {
        // inputReplyToStory or other — skip (tricky)
      }
    }

    // peer: InputPeer
    const peerKey = readInputPeerKey(reader, session);

    // message: string
    const message = readTlString(reader);

    return { peerKey, message, replyToMsgId };
  } catch (e) {
    console.log(`[WARN] parseSaveDraftRequest: parse error:`, (e as Error).message);
    return undefined;
  }
}

// ========== messages.sendReaction parser ==========

export interface ParsedSendReactionRequest {
  peerKey: string | undefined;
  msgId: number;
  reactions: string[]; // emoticons
}

export function parseSendReactionRequest(data: Buffer, session: ClientSession | undefined): ParsedSendReactionRequest | undefined {
  try {
    const reader = new BinaryReader(data);
    reader.offset = 4; // skip constructor
    const flags = reader.readInt();
    // big: flags.1 (true flag)
    // add_to_recent: flags.2 (true flag)

    // peer: InputPeer
    const peerKey = readInputPeerKey(reader, session);

    // msg_id: int
    const msgId = reader.readInt();

    // reaction: flags.0? Vector<Reaction>
    const reactions: string[] = [];
    if (flags & (1 << 0)) {
      const _vecCid = reader.readInt() >>> 0;
      const count = reader.readInt();
      for (let i = 0; i < count; i++) {
        const reactionCid = reader.readInt() >>> 0;
        if (reactionCid === 0x1b2286b8) {
          // reactionEmoji#1b2286b8 emoticon:string
          reactions.push(readTlString(reader));
        } else if (reactionCid === 0x8935fc73) {
          // reactionCustomEmoji#8935fc73 document_id:long
          const docId = reader.readLong(false);
          reactions.push(`custom:${docId}`);
        } else if (reactionCid === 0xa6d4b8d2) {
          // reactionEmpty — skip
        }
      }
    }

    return { peerKey, msgId, reactions };
  } catch (e) {
    console.log(`[WARN] parseSendReactionRequest: parse error:`, (e as Error).message);
    return undefined;
  }
}

// ========== messages.getFullChat parser ==========

export function parseGetFullChatRequest(data: Buffer): { chatId: number } | undefined {
  try {
    const reader = new BinaryReader(data);
    reader.offset = 4; // skip constructor
    const chatId = Number(reader.readLong(false));
    return { chatId };
  } catch (e) {
    console.log(`[WARN] parseGetFullChatRequest: parse error:`, (e as Error).message);
    return undefined;
  }
}

// ========== channels.getParticipants parser ==========

export interface ParsedGetParticipantsRequest {
  channelId: number;
  channelAccessHash: bigint;
  offset: number;
  limit: number;
}

export function parseGetParticipantsRequest(data: Buffer): ParsedGetParticipantsRequest | undefined {
  try {
    const reader = new BinaryReader(data);
    reader.offset = 4; // skip constructor

    // channel: InputChannel
    const channelCid = reader.readInt() >>> 0;
    let channelId = 0;
    let channelAccessHash = 0n;
    if (channelCid === 0xf35aec28) {
      // inputChannel#f35aec28 channel_id:long access_hash:long
      channelId = Number(reader.readLong(false));
      channelAccessHash = reader.readLong(false);
    }

    // filter: ChannelParticipantsFilter — skip (read constructor + possible fields)
    const filterCid = reader.readInt() >>> 0;
    if (filterCid === 0xbb6ae88d) {
      // channelParticipantsSearch#0bb6ae88d q:string
      readTlString(reader);
    } else if (filterCid === 0xa3b54985) {
      // channelParticipantsKicked#a3b54985 q:string
      readTlString(reader);
    } else if (filterCid === 0x0656ac4b) {
      // channelParticipantsBanned#0656ac4b q:string
      readTlString(reader);
    } else if (filterCid === 0x1427a5e1) {
      // channelParticipantsContacts#1427a5e1 q:string
      readTlString(reader);
    }
    // other filter types have no fields (channelParticipantsRecent, channelParticipantsAdmins, etc.)

    const offset = reader.readInt();
    const limit = reader.readInt();
    // hash: long
    reader.readLong(false);

    return { channelId, channelAccessHash, offset, limit };
  } catch (e) {
    console.log(`[WARN] parseGetParticipantsRequest: parse error:`, (e as Error).message);
    return undefined;
  }
}

// ========== channels.getParticipant parser ==========

export function parseGetParticipantRequest(data: Buffer, session: ClientSession | undefined): { channelId: number; participantPeerKey: string | undefined } | undefined {
  try {
    const reader = new BinaryReader(data);
    reader.offset = 4; // skip constructor

    // channel: InputChannel
    const channelCid = reader.readInt() >>> 0;
    let channelId = 0;
    if (channelCid === 0xf35aec28) {
      // inputChannel#f35aec28 channel_id:long access_hash:long
      channelId = Number(reader.readLong(false));
      reader.readLong(false); // access_hash
    }

    // participant: InputPeer
    const participantPeerKey = readInputPeerKey(reader, session);

    return { channelId, participantPeerKey };
  } catch (e) {
    console.log(`[WARN] parseGetParticipantRequest: parse error:`, (e as Error).message);
    return undefined;
  }
}

// ========== channels.inviteToChannel parser ==========

export interface ParsedInviteToChannelRequest {
  channelId: number;
  channelAccessHash: bigint;
  userIds: number[];
}

export function parseInviteToChannelRequest(data: Buffer): ParsedInviteToChannelRequest | undefined {
  try {
    const reader = new BinaryReader(data);
    reader.offset = 4; // skip constructor

    // channel: InputChannel
    const channelCid = reader.readInt() >>> 0;
    let channelId = 0;
    let channelAccessHash = 0n;
    if (channelCid === 0xf35aec28) {
      channelId = Number(reader.readLong(false));
      channelAccessHash = reader.readLong(false);
    }

    // users: Vector<InputUser>
    const _vecCid = reader.readInt() >>> 0;
    const userCount = reader.readInt();
    const userIds: number[] = [];
    for (let i = 0; i < userCount; i++) {
      const userCid = reader.readInt() >>> 0;
      if (userCid === 0xf7c1b13f) {
        // inputUserSelf
        userIds.push(-1); // sentinel
      } else if (userCid === 0xf21158c6) {
        // inputUser#f21158c6 user_id:long access_hash:long
        userIds.push(Number(reader.readLong(false)));
        reader.readLong(false); // access_hash
      } else {
        userIds.push(0);
      }
    }

    return { channelId, channelAccessHash, userIds };
  } catch (e) {
    console.log(`[WARN] parseInviteToChannelRequest: parse error:`, (e as Error).message);
    return undefined;
  }
}

// ========== channels.editPhoto parser ==========

export function parseEditPhotoRequest(data: Buffer): { channelId: number; channelAccessHash: bigint; fileId?: string } | undefined {
  try {
    const reader = new BinaryReader(data);
    reader.offset = 4; // skip constructor

    // channel: InputChannel
    const channelCid = reader.readInt() >>> 0;
    let channelId = 0;
    let channelAccessHash = 0n;
    if (channelCid === 0xf35aec28) {
      channelId = Number(reader.readLong(false));
      channelAccessHash = reader.readLong(false);
    }

    // photo: InputChatPhoto
    let fileId: string | undefined;
    const photoCid = reader.readInt() >>> 0;
    if (photoCid === 0xbdcdaec0) {
      // inputChatUploadedPhoto#bdcdaec0 flags:# file:flags.0?InputFile video:flags.1?InputFile video_start_ts:flags.2?double video_emoji_markup:flags.3?VideoSize
      const photoFlags = reader.readInt() >>> 0;
      if (photoFlags & (1 << 0)) {
        // file: InputFile
        const inputFile = parseInputFile(reader);
        if (inputFile) {
          fileId = inputFile.fileId;
        }
      }
    } else if (photoCid === 0x8953ad37) {
      // inputChatPhoto#8953ad37 id:InputPhoto
      // Just skip — this references an existing photo we don't handle
    }
    // inputChatPhotoEmpty#1ca48f57 — no fields, means remove photo

    return { channelId, channelAccessHash, fileId };
  } catch (e) {
    console.log(`[WARN] parseEditPhotoRequest: parse error:`, (e as Error).message);
    return undefined;
  }
}

// ========== messages.editChatPhoto parser ==========

export function parseEditChatPhotoRequest(data: Buffer): { chatId: number; fileId?: string } | undefined {
  try {
    const reader = new BinaryReader(data);
    reader.offset = 4; // skip constructor

    // chat_id: long
    const chatId = Number(reader.readLong(false));

    // photo: InputChatPhoto
    let fileId: string | undefined;
    const photoCid = reader.readInt() >>> 0;
    if (photoCid === 0xbdcdaec0) {
      // inputChatUploadedPhoto#bdcdaec0 flags:# file:flags.0?InputFile ...
      const photoFlags = reader.readInt() >>> 0;
      if (photoFlags & (1 << 0)) {
        const inputFile = parseInputFile(reader);
        if (inputFile) fileId = inputFile.fileId;
      }
    }

    return { chatId, fileId };
  } catch (e) {
    console.log(`[WARN] parseEditChatPhotoRequest: parse error:`, (e as Error).message);
    return undefined;
  }
}

// ========== photos.uploadProfilePhoto parser ==========

export function parseUploadProfilePhotoRequest(data: Buffer, session: ClientSession | undefined): ParsedUploadProfilePhotoRequest | undefined {
  try {
    const reader = new BinaryReader(data);
    reader.offset = 4; // skip constructor

    const flags = reader.readInt() >>> 0;
    let targetUserId: number | undefined;
    let fileId: string | undefined;

    if (flags & (1 << 5)) {
      const user = readInputUserRef(reader, session);
      if (user) {
        targetUserId = Number(user.userId);
      }
    }

    if (flags & (1 << 0)) {
      const inputFile = parseInputFile(reader);
      if (inputFile) {
        fileId = inputFile.fileId;
      }
    }

    return { fileId, targetUserId };
  } catch (e) {
    console.log(`[WARN] parseUploadProfilePhotoRequest: parse error:`, (e as Error).message);
    return undefined;
  }
}
