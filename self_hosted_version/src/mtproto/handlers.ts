import { gunzipSync } from 'zlib';
import { randomBytes } from 'crypto';
import { existsSync as _fsExists, readFileSync as _fsRead } from 'fs';
import { dirname as _dirname, resolve as _resolve } from 'path';
import { fileURLToPath as _fileURLToPath } from 'url';
import { BinaryReader, BinaryWriter } from './codec.js';

const _dataFilesDir = _resolve(_dirname(_fileURLToPath(import.meta.url)), '../../data/files');
import { sha1Sync } from '../crypto/utils.js';
import { getMessageStore } from '../database/messageStore.js';
import type { FixtureMessage } from './officialCaptureFixture.js';
import { skipInitConnection, parseInitConnection, writeTlString, writeTlBytes, writeEmptyVectorToWriter, skipInputPeer, parseInputReplyTo, readTlString, skipTlStringByReader, readTlBytesRaw } from './tlHelpers.js';
import { writeUserFromFixture, writePhotoObject, isFieldVisibleByPrivacy } from './writers.js';
import { authCodeLimiter, authSignInLimiter, messageLimiter } from '../utils/rateLimiter.js';
import { validatePhone, validateAuthCode, validateMessageText, validateName, validateUsername, validatePeerKey, validateMessageIds, LIMITS } from '../utils/validation.js';
import {
  SEED_USER_ID,
  getStoredMessageAsFixture,
  listStoredMessagesAsFixtureForUser,
  collectEntityIdsFromPeerKey,
  getFixtureUserForId,
  buildActionForFixture,
} from './fixtureHelpers.js';
import {
  setActiveSession,
  readInputPeerKey,
  parseHistoryRequest,
  parseGetMessagesRequest,
  parsePeerDialogsRequest,
  parseSetTypingRequest,
  parseEditMessageRequest,
  parseDeleteMessagesRequest,
  parseReadHistoryRequest,
  parseChannelReadHistoryRequest,
  parseUpdatesDifferenceRequest,
  parseGetFullChannelRequest,
  parseGetFullUserRequest,
  parseGetUsersRequest,
  parsePeerVectorRequest,
  parseSendMessageRequest,
  parseSendMediaRequest,
  parseForwardMessagesRequest,
  parseSearchRequest,
  parseSearchGlobalRequest,
  parseCreateChatRequest,
  parseCreateChannelRequest,
  parseSaveDraftRequest,
  parseSendReactionRequest,
  parseGetFullChatRequest,
  parseGetParticipantsRequest,
  parseGetParticipantRequest,
  parseInviteToChannelRequest,
  parseEditPhotoRequest,
  parseEditChatPhotoRequest,
  parseUploadProfilePhotoRequest,
  readInputUserRef,
} from './parsers.js';
import {
  buildConfig,
  buildAppConfig,
  buildUpdatesState,
  buildLangPackDifference,
  buildLangPackStringsResponse,
  buildLangPackLanguage,
  buildEmptyVector,
  buildUpdatesDifference,
  buildUpdateReadHistoryInbox,
  buildUpdateReadHistoryOutbox,
  buildUpdateNewMessage,
  buildUpdateEditMessage,
  buildUpdateDeleteMessages,
  buildUpdateMessageID,
  buildUpdateUserStatus,
  buildUpdateUserNameUpdate,
  buildUpdateUserTyping,
  buildLiveUpdatesEnvelope,
  buildLiveNewMessageUpdates,
  buildLiveReadHistoryUpdates,
  buildUserFullForUser,
  buildUsersVector,
  buildUsersVectorForIds,
  buildDialogFilters,
  buildDialogsFromDb,
  buildPeerDialogsForPeers,
  buildPinnedDialogs,
  buildGetMessagesResponse,
  buildMessagesSliceEmpty,
  buildMessagesEmpty,
  buildWebPagePreviewEmpty,
  buildRecentStoriesVector,
  buildSentCode,
  buildAuthAuthorization,
  buildAuthSignUpRequired,
  buildLoginToken,
  buildContactsFromDb,
  buildContactsFound,
  buildResolvedPeer,
  buildResolvedPeerForUser,
  buildChannelFullEmpty,
  buildBoolTrue,
  buildBoolFalse,
  buildNearestDc,
  buildPeerNotifySettings,
  buildPeerColorsEmpty,
  buildPeerProfileColors,
  buildCountriesListEmpty,
  buildPromoDataEmpty,
  buildAuthorizationsEmpty,
  buildAuthorizations,
  buildWallPapersNotModified,
  buildStickerSetNotModified,
  buildUpdatesEmpty,
  buildTopPeersDisabled,
  buildBlockedEmpty,
  buildAvailableReactionsNotModified,
  buildAvailableReactions,
  buildSavedDialogsEmpty,
  buildSponsoredMessagesEmpty,
  buildSponsoredPeersEmpty,
  buildSearchPostsFlood,
  buildAllStoriesEmpty,
  buildReactionsEmpty,
  buildGlobalPrivacySettingsFromDb,
  buildTimezonesListEmpty,
  buildPrivacyRules,
  buildSavedReactionTagsEmpty,
  buildQuickRepliesEmpty,
  buildAvailableEffectsEmpty,
  buildAttachMenuBotsNotModified,
  buildStarsStatusEmpty,
  buildEmojiStatusesEmpty,
  buildStarGiftsEmpty,
  buildSavedStarGiftsEmpty,
  buildStarGiftActiveAuctionsEmpty,
  buildTermsOfServiceUpdateEmpty,
  buildEmojiKeywordsDifference,
  buildEmojiURL,
  buildReactionsNotModified,
  buildTopReactions,
  buildRecentReactions,
  buildDefaultHistoryTTL,
  buildContentSettings,
  buildAccountPassword,
  buildAllStickersNotModified,
  buildAllStickersEmpty,
  buildEmojiStickers,
  buildFeaturedEmojiStickers,
  buildStickerSetFromCapture,
  buildStickerSetFromCaptureByShortName,
  buildStickerSetFromCaptureByTypeName,
  buildFeaturedStickersNotModified,
  buildRecentStickersNotModified,
  buildSavedGifsNotModified,
  buildFavedStickersNotModified,
  buildAffectedMessages,
  buildRpcErrorObject,
  buildInvitedUsers,
  buildCreateChannelUpdates,
  buildChatFull,
  buildChannelParticipants,
  buildLiveUpdatesEnvelopeWithChats,
  buildChannelParticipantSingle,
  buildUpdateMessageReactions,
  buildLiveUpdateMessageReactions,
} from './builders.js';
import type { ClientSession } from './server.js';

const messageStore = getMessageStore();

function getKeyIdHex(authKey: Buffer): string {
  return sha1Sync(authKey).slice(12, 20).toString('hex');
}

function aggregateReactions(ownerUserId: number, peerKey: string, messageId: number, selfUserId: number): Array<{ emoticon: string; count: number; chosenOrder?: number }> {
  const stored = messageStore.getReactions(ownerUserId, peerKey, messageId);
  if (!stored || stored.length === 0) return [];
  const map = new Map<string, { count: number; isMine: boolean }>();
  for (const r of stored) {
    const existing = map.get(r.emoticon);
    if (existing) {
      existing.count++;
      if (r.userId === selfUserId) existing.isMine = true;
    } else {
      map.set(r.emoticon, { count: 1, isMine: r.userId === selfUserId });
    }
  }
  let chosenIdx = 0;
  return Array.from(map.entries()).map(([emoticon, { count, isMine }]) => ({
    emoticon,
    count,
    chosenOrder: isMine ? chosenIdx++ : undefined,
  }));
}

export interface HandlerCallbacks {
  authKeyUserMap: Map<string, number>;
  broadcastToUser: (targetUserId: number, responseData: Buffer | null, excludeSessionId?: string) => void;
  broadcastSessionUpdates: (sourceSession: ClientSession, responseData: Buffer | null) => void;
  removeAuthKey: (authKey: Buffer) => void;
}

/** Extract width/height from JPEG or PNG file headers */
function getImageDimensions(data: Buffer): { width: number; height: number } | null {
  // JPEG: scan for SOF0 (0xFFC0) or SOF2 (0xFFC2)
  if (data.length > 2 && data[0] === 0xFF && data[1] === 0xD8) {
    let offset = 2;
    while (offset + 4 < data.length) {
      if (data[offset] !== 0xFF) break;
      const marker = data[offset + 1];
      if (marker === 0xC0 || marker === 0xC2) {
        if (offset + 9 < data.length) {
          const height = data.readUInt16BE(offset + 5);
          const width = data.readUInt16BE(offset + 7);
          return { width, height };
        }
        break;
      }
      // Skip this marker segment
      const segLen = data.readUInt16BE(offset + 2);
      offset += 2 + segLen;
    }
  }
  // PNG: IHDR at offset 16
  if (data.length > 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) {
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);
    return { width, height };
  }
  return null;
}

// ========== Privacy key / rule helpers ==========

/** Map InputPrivacyKey constructor ID to a string key for DB storage */
function inputPrivacyKeyToString(cid: number): string {
  switch (cid) {
    case 0x4f96cb18: return 'statusTimestamp';
    case 0xbdfb0426: return 'chatInvite';
    case 0xfabadc5f: return 'phoneCall';
    case 0xdb9e70d2: return 'phoneP2P';
    case 0xa4dd4c08: return 'forwards';
    case 0x5719bacc: return 'profilePhoto';
    case 0x0352dafa: return 'phoneNumber';
    case 0xd1219bdd: return 'addedByPhone';
    case 0xaee69d68: return 'voiceMessages';
    case 0x3823cc40: return 'about';
    case 0xd65a11cc: return 'birthday';
    case 0xe1732341: return 'starGiftsAutoSave';
    case 0xbdc597b4: return 'noPaidMessages';
    default: return `unknown_${cid.toString(16)}`;
  }
}

/** Parse a single InputPrivacyRule from the reader */
function parseInputPrivacyRule(reader: BinaryReader, cid: number): { ruleType: string; value: number[] } | null {
  switch (cid) {
    case 0x0d09e07b: return { ruleType: 'allowContacts', value: [] };        // inputPrivacyValueAllowContacts
    case 0x184b35ce: return { ruleType: 'allowAll', value: [] };             // inputPrivacyValueAllowAll
    case 0x0ba52007: return { ruleType: 'disallowContacts', value: [] };     // inputPrivacyValueDisallowContacts
    case 0xd66b66c9: return { ruleType: 'disallowAll', value: [] };          // inputPrivacyValueDisallowAll
    case 0x2f453e49: return { ruleType: 'allowCloseFriends', value: [] };    // inputPrivacyValueAllowCloseFriends
    case 0x77cdc9f1: return { ruleType: 'allowPremium', value: [] };         // inputPrivacyValueAllowPremium
    case 0x5a4fcce5: return { ruleType: 'allowBots', value: [] };            // inputPrivacyValueAllowBots
    case 0xc4e57915: return { ruleType: 'disallowBots', value: [] };         // inputPrivacyValueDisallowBots

    case 0x131cc67f: { // inputPrivacyValueAllowUsers — users:Vector<InputUser>
      const vecCid = reader.readInt() >>> 0;
      const count = reader.readInt();
      const userIds: number[] = [];
      for (let i = 0; i < count; i++) {
        const inputUserCid = reader.readInt() >>> 0;
        if (inputUserCid === 0xf7c1b13f) {
          // inputUserSelf — use 0 as placeholder, will be resolved
          userIds.push(0);
        } else {
          // inputUser#f21158c6 user_id:long access_hash:long
          const uid = Number(reader.readLong());
          reader.readLong(); // access_hash
          userIds.push(uid);
        }
      }
      return { ruleType: 'allowUsers', value: userIds };
    }

    case 0x90110467: { // inputPrivacyValueDisallowUsers — users:Vector<InputUser>
      const vecCid = reader.readInt() >>> 0;
      const count = reader.readInt();
      const userIds: number[] = [];
      for (let i = 0; i < count; i++) {
        const inputUserCid = reader.readInt() >>> 0;
        if (inputUserCid === 0xf7c1b13f) {
          userIds.push(0);
        } else {
          const uid = Number(reader.readLong());
          reader.readLong(); // access_hash
          userIds.push(uid);
        }
      }
      return { ruleType: 'disallowUsers', value: userIds };
    }

    case 0x840649cf: { // inputPrivacyValueAllowChatParticipants — chats:Vector<long>
      const vecCid = reader.readInt() >>> 0;
      const count = reader.readInt();
      const chatIds: number[] = [];
      for (let i = 0; i < count; i++) chatIds.push(Number(reader.readLong()));
      return { ruleType: 'allowChatParticipants', value: chatIds };
    }

    case 0xe94f0f86: { // inputPrivacyValueDisallowChatParticipants — chats:Vector<long>
      const vecCid = reader.readInt() >>> 0;
      const count = reader.readInt();
      const chatIds: number[] = [];
      for (let i = 0; i < count; i++) chatIds.push(Number(reader.readLong()));
      return { ruleType: 'disallowChatParticipants', value: chatIds };
    }

    default:
      console.warn(`[Privacy] Unknown InputPrivacyRule constructor: 0x${cid.toString(16)}`);
      return null;
  }
}

// ===== PHONE CALLS INFRASTRUCTURE =====

interface CallRecord {
  id: bigint;
  adminId: number;
  participantId: number;
  adminAccessHash: bigint;
  participantAccessHash: bigint;
  date: number;
  receiveDate: number;
  startDate: number;
  state: 'waiting' | 'accepted' | 'active' | 'discarded';
  video: boolean;
  gaHash: Buffer;
  gb: Buffer;
  ga: Buffer;
  keyFingerprint: bigint;
}

const _callsMap = new Map<string, CallRecord>();
const _exportedAuths = new Map<string, number>(); // tokenHex → userId (auth.exportAuthorization temp store)

function _callKey(id: bigint): string {
  return id.toString();
}

// Standard Telegram 2048-bit safe prime (g=3, RFC 7919 / TL spec)
const _TG_DH_PRIME = Buffer.from(
  'C71CAEB9C6B1C9048E6C522F70F13F73980D40238E3E21C14934D037563D930F' +
  '48198A0AA7C14058229493D22530F4DBFA336F6E0AC925139543AED44CCE7C37' +
  '20FD51F69458705AC68CD4FE6B6B13ABDC9746512969328454F18FAF8C595F64' +
  '2477FE96BB2A941D5BCD1D4AC8CC49880708FA9B378E3C4F3A9060BEE67CF9A4' +
  'A4A695811051907E162753B56B0F6B410DBA74D8A84B2A14B3144E0EF1284754' +
  'FD17ED950D5965B4B9DD46582DB1178D169C6BC465B0D6FF9CA3928FEF5B9AE4' +
  'E418FC15E83EBEA0F87FA9FF5EED70050DED2849F47BF959D956850CE929851F' +
  '0D8115F635B105EE2E4E15D04B2454BF6F4FADF034B10403119CD8E3B92FCC5B',
  'hex',
);

function _writePhoneCallProtocol(w: BinaryWriter): void {
  // PhoneCallProtocol#fc878fc8 flags:# udp_p2p:flags.0?true udp_reflector:flags.1?true
  //   min_layer:int max_layer:int library_versions:Vector<string>
  w.writeInt(0xfc878fc8);
  w.writeInt(3); // flags: bit0=udp_p2p, bit1=udp_reflector
  w.writeInt(92); // min_layer
  w.writeInt(92); // max_layer
  // Vector<string> = 0x1cb5c415 count:int items…
  // Must include '4.0.0' — web_client rejects calls without it (verifyPhoneCallProtocol check)
  w.writeInt(0x1cb5c415);
  w.writeInt(1);
  writeTlString(w, '4.0.0');
}

// phone.PhoneCall#ec82e140 phone_call:PhoneCall users:Vector<User>
function _buildPhoneCallContainer(phoneCallBuf: Buffer): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0xec82e140);
  w.writeBytes(phoneCallBuf);
  // empty users vector
  w.writeInt(0x1cb5c415);
  w.writeInt(0);
  return w.getBytes();
}

// PhoneCallWaiting#c5226f17
// flags:# video:flags.6?true id:long access_hash:long date:int
// admin_id:long participant_id:long protocol:PhoneCallProtocol
// receive_date:flags.0?int
function _buildPhoneCallWaiting(call: CallRecord, accessHash: bigint, includeReceiveDate: boolean): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0xc5226f17);
  const flags = (call.video ? 64 : 0) | (includeReceiveDate ? 1 : 0);
  w.writeInt(flags);
  w.writeLong(call.id);
  w.writeLong(accessHash);
  w.writeInt(call.date);
  w.writeLong(BigInt(call.adminId));
  w.writeLong(BigInt(call.participantId));
  _writePhoneCallProtocol(w);
  if (includeReceiveDate) {
    w.writeInt(call.receiveDate);
  }
  return w.getBytes();
}

// PhoneCallRequested#14b0ed0c
// flags:# video:flags.6?true id:long access_hash:long date:int
// admin_id:long participant_id:long g_a_hash:bytes protocol:PhoneCallProtocol
function _buildPhoneCallRequested(call: CallRecord, accessHash: bigint): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x14b0ed0c);
  w.writeInt(call.video ? 64 : 0); // flags
  w.writeLong(call.id);
  w.writeLong(accessHash);
  w.writeInt(call.date);
  w.writeLong(BigInt(call.adminId));
  w.writeLong(BigInt(call.participantId));
  writeTlBytes(w, call.gaHash);
  _writePhoneCallProtocol(w);
  return w.getBytes();
}

// PhoneCallAccepted#3660c311
// flags:# video:flags.6?true id:long access_hash:long date:int
// admin_id:long participant_id:long g_b:bytes protocol:PhoneCallProtocol
function _buildPhoneCallAccepted(call: CallRecord, accessHash: bigint): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x3660c311);
  w.writeInt(call.video ? 64 : 0);
  w.writeLong(call.id);
  w.writeLong(accessHash);
  w.writeInt(call.date);
  w.writeLong(BigInt(call.adminId));
  w.writeLong(BigInt(call.participantId));
  writeTlBytes(w, call.gb);
  _writePhoneCallProtocol(w);
  return w.getBytes();
}

// phoneConnectionWebrtc#635fe375
// flags:# turn:flags.0?true stun:flags.1?true id:long ip:string ipv6:string port:int username:string password:string
function _buildPhoneConnectionWebrtc(
  id: bigint, ip: string, port: number,
  isTurn: boolean, isStun: boolean,
  username: string, password: string,
): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x635fe375);
  const flags = (isTurn ? 1 : 0) | (isStun ? 2 : 0);
  w.writeInt(flags);
  w.writeLong(id);
  writeTlString(w, ip);
  writeTlString(w, ''); // ipv6 empty
  w.writeInt(port);
  writeTlString(w, username);
  writeTlString(w, password);
  return w.getBytes();
}

// Read coturn config from env once
const _coturnHost = process.env.COTURN_HOST || '';
const _coturnPort = parseInt(process.env.COTURN_PORT || '3478', 10);
const _coturnUser = process.env.COTURN_USER || '';
const _coturnPass = process.env.COTURN_PASS || '';

function _buildConnectionsVector(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x1cb5c415); // vector constructor
  if (_coturnHost) {
    // TURN + STUN entry on the same server
    w.writeInt(2);
    w.writeBytes(_buildPhoneConnectionWebrtc(BigInt(1), _coturnHost, _coturnPort, true, false, _coturnUser, _coturnPass));
    w.writeBytes(_buildPhoneConnectionWebrtc(BigInt(2), _coturnHost, _coturnPort, false, true, '', ''));
  } else {
    // Fallback: Google public STUN (no credentials)
    w.writeInt(1);
    w.writeBytes(_buildPhoneConnectionWebrtc(BigInt(1), 'stun.l.google.com', 19302, false, true, '', ''));
  }
  return w.getBytes();
}

// PhoneCall#30535af5 (active)
// flags:# p2p_allowed:flags.5?true video:flags.6?true conference_supported:flags.8?true
// id:long access_hash:long date:int admin_id:long participant_id:long
// g_a_or_b:bytes key_fingerprint:long protocol:PhoneCallProtocol
// connections:Vector<PhoneConnection> start_date:int custom_parameters:flags.7?DataJSON
function _buildPhoneCallActive(call: CallRecord, accessHash: bigint, gAOrB: Buffer): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x30535af5);
  // p2p_allowed bit5=32, video bit6=64
  const flags = 32 | (call.video ? 64 : 0);
  w.writeInt(flags);
  w.writeLong(call.id);
  w.writeLong(accessHash);
  w.writeInt(call.date);
  w.writeLong(BigInt(call.adminId));
  w.writeLong(BigInt(call.participantId));
  writeTlBytes(w, gAOrB);
  w.writeLong(call.keyFingerprint);
  _writePhoneCallProtocol(w);
  w.writeBytes(_buildConnectionsVector());
  w.writeInt(call.startDate);
  return w.getBytes();
}

// PhoneCallDiscarded#50ca4de1
// flags:# need_rating:flags.2?true need_debug:flags.3?true video:flags.6?true
// id:long reason:flags.0?PhoneCallDiscardReason duration:flags.1?int
function _buildPhoneCallDiscarded(id: bigint): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x50ca4de1);
  w.writeInt(0); // flags
  w.writeLong(id);
  return w.getBytes();
}

// UpdatePhoneCall#ab0f6b1e phone_call:PhoneCall
function _buildUpdatePhoneCall(phoneCallBuf: Buffer): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0xab0f6b1e);
  w.writeBytes(phoneCallBuf);
  return w.getBytes();
}

// Reads InputPhoneCall#1e36fded id:long access_hash:long from reader (after constructor)
function _readInputPhoneCall(r: BinaryReader): { id: bigint; accessHash: bigint } {
  const cid = r.readInt() >>> 0;
  if (cid !== 0x1e36fded) {
    throw new Error(`Expected InputPhoneCall, got 0x${cid.toString(16)}`);
  }
  const id = r.readLong(false);
  const accessHash = r.readLong(false);
  return { id, accessHash };
}

// ===== END PHONE CALLS INFRASTRUCTURE =====

export function handleTlRequest(
  data: Buffer,
  session: ClientSession,
  reqMsgId: bigint,
  ctx: HandlerCallbacks,
): Buffer | null {
  setActiveSession(session);
  const constructorId = data.readUInt32LE(0);

  switch (constructorId) {
    case 0xda9b0d0d: { // invokeWithLayer
      const layer = data.readInt32LE(4);
      session.layer = layer;
      // console.log(`[${new Date().toISOString()}] Session ${session.id} invokeWithLayer: ${layer}`);
      return handleTlRequest(data.slice(8), session, reqMsgId, ctx);
    }

    case 0xc1cd5ea9: { // initConnection
      // console.log(`[${new Date().toISOString()}] Session ${session.id} initConnection`);
      const connInfo = parseInitConnection(data);
      if (connInfo) {
        // Register/update session metadata
        if (session.authKey) {
          const keyHex = getKeyIdHex(session.authKey);
          messageStore.upsertSession(keyHex, session.userId, {
            deviceModel: connInfo.deviceModel,
            platform: connInfo.systemVersion,
            appVersion: connInfo.appVersion,
          });
        }
        return handleTlRequest(connInfo.innerQuery, session, reqMsgId, ctx);
      }
      const innerQuery = skipInitConnection(data);
      if (innerQuery) return handleTlRequest(innerQuery, session, reqMsgId, ctx);
      return buildConfig();
    }

    case 0xc4f9186b: { // help.getConfig
      // console.log(`[${new Date().toISOString()}] Session ${session.id} help.getConfig`);
      return buildConfig();
    }

    case 0x61003e28: // help.getAppConfig (old)
    case 0x61e3f854: { // help.getAppConfig (new with hash)
      // console.log(`[${new Date().toISOString()}] Session ${session.id} help.getAppConfig`);
      return buildAppConfig();
    }

    case 0xda80f42f: { // help.getPeerColors
      // console.log(`[${new Date().toISOString()}] Session ${session.id} help.getPeerColors`);
      return buildPeerColorsEmpty();
    }

    case 0xabcfa9fd: { // help.getPeerProfileColors
      // console.log(`[${new Date().toISOString()}] Session ${session.id} help.getPeerProfileColors`);
      return buildPeerProfileColors();
    }

    // ========== AUTH METHODS ==========

    case 0xcdd42a05: { // auth.bindTempAuthKey
      // Android uses PFS (Perfect Forward Secrecy) with temp auth keys
      // We just accept and return true since our server uses perm keys directly
      console.log(`[${new Date().toISOString()}] Session ${session.id} auth.bindTempAuthKey`);
      return buildBoolTrue();
    }

    case 0x518ad0b7: { // account.initPasskeyLogin
      console.log(`[${new Date().toISOString()}] Session ${session.id} account.initPasskeyLogin`);
      // Return valid passkeyLoginOptions with empty allowCredentials
      // so client's CredentialManager fails silently (no passkeys registered)
      const pw = new BinaryWriter();
      pw.writeInt(0xe2037789);  // account.passkeyLoginOptions
      pw.writeInt(0x7d748d04);  // dataJSON
      const webauthnJson = JSON.stringify({
        publicKey: {
          challenge: 'AAAAAAAAAAAAAAAAAAAAAA',
          rpId: process.env.DOMAIN || 'pluma.chat',
          allowCredentials: [],
          timeout: 60000,
          userVerification: 'discouraged',
        },
      });
      writeTlString(pw, webauthnJson);
      return pw.getBytes();
    }

    case 0xb7e085fe: { // auth.exportLoginToken
      console.log(`[${new Date().toISOString()}] Session ${session.id} auth.exportLoginToken`);
      return buildLoginToken();
    }

    case 0xe5bfffcd: { // auth.exportAuthorization
      const eaReader = new BinaryReader(data);
      eaReader.offset = 4;
      const eaDcId = eaReader.readInt();
      console.log(`[${new Date().toISOString()}] Session ${session.id} auth.exportAuthorization dc_id=${eaDcId} userId=${session.userId}`);
      if (!session.userId) return buildRpcErrorObject(401, 'AUTH_KEY_UNREGISTERED');
      // Single DC — return userId + random bytes as token
      const exportToken = randomBytes(128);
      // Store the token temporarily so importAuthorization can validate it
      _exportedAuths.set(exportToken.toString('hex'), session.userId);
      setTimeout(() => _exportedAuths.delete(exportToken.toString('hex')), 60000);
      const eaW = new BinaryWriter();
      eaW.writeInt(0xb434e2b8); // auth.exportedAuthorization
      eaW.writeLong(BigInt(session.userId)); // id
      writeTlBytes(eaW, exportToken); // bytes
      return eaW.getBytes();
    }

    case 0xa57a7dad: { // auth.importAuthorization
      const iaReader = new BinaryReader(data);
      iaReader.offset = 4;
      const iaUserId = Number(iaReader.readLong());
      const iaBytes = readTlBytesRaw(iaReader);
      console.log(`[${new Date().toISOString()}] Session ${session.id} auth.importAuthorization userId=${iaUserId}`);
      const iaTokenHex = Buffer.from(iaBytes).toString('hex');
      const storedUserId = _exportedAuths.get(iaTokenHex);
      if (storedUserId && storedUserId === iaUserId) {
        _exportedAuths.delete(iaTokenHex);
      }
      // Accept regardless — single DC, just set the session userId
      session.userId = iaUserId;
      const messageStore = getMessageStore();
      const iaUser = messageStore.getUserById(iaUserId);
      if (!iaUser) return buildRpcErrorObject(401, 'AUTH_KEY_UNREGISTERED');
      return buildAuthAuthorization(iaUser);
    }

    case 0xa677244f: { // auth.sendCode
      const reader = new BinaryReader(data);
      reader.offset = 4;
      const phoneNumber = readTlString(reader);
      console.log(`[${new Date().toISOString()}] Session ${session.id} auth.sendCode phone=${phoneNumber}`);
      const phoneErr = validatePhone(phoneNumber);
      if (phoneErr) return buildRpcErrorObject(400, phoneErr);
      if (!authCodeLimiter.check(phoneNumber)) {
        return buildRpcErrorObject(420, 'FLOOD_WAIT_300');
      }
      const authCode = messageStore.generateAuthCode(phoneNumber);
      console.log(`\n  *** AUTH CODE for ${phoneNumber}: ${authCode.code} ***\n`);
      return buildSentCode(authCode.phoneCodeHash, 5);
    }

    case 0x8d52a951: { // auth.signIn
      const reader = new BinaryReader(data);
      reader.offset = 4;
      const flags = reader.readInt() >>> 0;
      const phoneNumber = readTlString(reader);
      const phoneCodeHash = readTlString(reader);
      let phoneCode: string | undefined;
      if (flags & (1 << 0)) {
        phoneCode = readTlString(reader);
      }
      console.log(`[${new Date().toISOString()}] Session ${session.id} auth.signIn phone=${phoneNumber}`);

      if (!phoneCode) {
        return buildRpcErrorObject(400, 'PHONE_CODE_EMPTY');
      }
      const codeErr = validateAuthCode(phoneCode);
      if (codeErr) return buildRpcErrorObject(400, codeErr);
      if (!authSignInLimiter.check(phoneNumber)) {
        return buildRpcErrorObject(420, 'FLOOD_WAIT_300');
      }

      if (!messageStore.verifyAuthCode(phoneNumber, phoneCodeHash, phoneCode)) {
        return buildRpcErrorObject(400, 'PHONE_CODE_INVALID');
      }

      const existingUser = messageStore.getUserByPhone(phoneNumber);
      if (existingUser) {
        session.userId = existingUser.id;
        messageStore.setUserOnline(existingUser.id);
        if (session.authKey) {
          const keyHex = getKeyIdHex(session.authKey);
          ctx.authKeyUserMap.set(keyHex, existingUser.id);
          messageStore.bindAuthKeyToUser(keyHex, existingUser.id);
          messageStore.upsertSession(keyHex, existingUser.id);
        }
        console.log(`[${new Date().toISOString()}] Session ${session.id} signed in as userId=${existingUser.id}`);
        return buildAuthAuthorization(existingUser);
      }

      console.log(`[${new Date().toISOString()}] Session ${session.id} sign up required for ${phoneNumber}`);
      return buildAuthSignUpRequired();
    }

    case 0xaac7b717: { // auth.signUp
      const reader = new BinaryReader(data);
      reader.offset = 4;
      reader.readInt() >>> 0; // flags
      const phoneNumber = readTlString(reader);
      const phoneCodeHash = readTlString(reader);
      const firstName = readTlString(reader);
      const lastName = readTlString(reader);
      console.log(`[${new Date().toISOString()}] Session ${session.id} auth.signUp phone=${phoneNumber} name=${firstName} ${lastName}`);

      const phoneErr = validatePhone(phoneNumber);
      if (phoneErr) return buildRpcErrorObject(400, phoneErr);
      const fnErr = validateName(firstName, 'FIRSTNAME');
      if (fnErr) return buildRpcErrorObject(400, fnErr);
      const lnErr = validateName(lastName, 'LASTNAME');
      if (lnErr) return buildRpcErrorObject(400, lnErr);

      const newUser = messageStore.createUser(phoneNumber, firstName, lastName);
      session.userId = newUser.id;
      messageStore.setUserOnline(newUser.id);
      if (session.authKey) {
        const keyHex = getKeyIdHex(session.authKey);
        ctx.authKeyUserMap.set(keyHex, newUser.id);
        messageStore.bindAuthKeyToUser(keyHex, newUser.id);
        messageStore.upsertSession(keyHex, newUser.id);
      }
      console.log(`[${new Date().toISOString()}] Session ${session.id} signed up as userId=${newUser.id}`);
      return buildAuthAuthorization(newUser);
    }

    case 0x3e72ba19: { // auth.logOut
      console.log(`[${new Date().toISOString()}] Session ${session.id} auth.logOut`);
      if (session.authKey) {
        const keyHex = getKeyIdHex(session.authKey);
        ctx.authKeyUserMap.delete(keyHex);
        messageStore.bindAuthKeyToUser(keyHex, 0);
        messageStore.deleteSession(keyHex);
        ctx.removeAuthKey(session.authKey);
      }
      session.userId = undefined;
      session.authKey = undefined;
      const w = new BinaryWriter();
      w.writeInt(0xc3a2835f);
      w.writeInt(0);
      return w.getBytes();
    }

    case 0xb921197a: // updates.getState (old)
    case 0xedd4882a: { // updates.getState
      console.log(`[${new Date().toISOString()}] Session ${session.id} updates.getState (userId=${session.userId || 'none'})`);
      if (!session.userId) {
        return buildRpcErrorObject(401, 'AUTH_KEY_UNREGISTERED');
      }
      // Push any pending incoming calls for this user (late-join: callee opened page after call was placed)
      // Use setTimeout so the update arrives after the client has initialized its update manager
      const stateUserId = session.userId;
      for (const [, pendingCall] of _callsMap) {
        if (pendingCall.participantId === stateUserId && pendingCall.state === 'waiting') {
          setTimeout(() => {
            const requestedBuf = _buildPhoneCallRequested(pendingCall, pendingCall.participantAccessHash);
            const pendingUpdateBuf = _buildUpdatePhoneCall(requestedBuf);
            const pendingEnvelope = buildLiveUpdatesEnvelope(
              [pendingUpdateBuf],
              [String(pendingCall.adminId), String(pendingCall.participantId)],
              [],
            );
            ctx.broadcastToUser(stateUserId, pendingEnvelope);
            console.log(`[${new Date().toISOString()}] Late-join: pushed pending PhoneCallRequested to userId=${stateUserId} (callId=${pendingCall.id.toString(16)})`);
          }, 2000);
        }
      }
      return buildUpdatesState(session.userId);
    }

    case 0xf3427b8c: { // ping_delay_disconnect
      const pingId = data.readBigInt64LE(4);
      const pongW = new BinaryWriter();
      pongW.writeInt(0x347773c5);
      pongW.writeLong(reqMsgId);
      pongW.writeLong(pingId);
      return pongW.getBytes();
    }

    case 0x7abe77ec: { // ping
      const pingId = data.readBigInt64LE(4);
      // console.log(`[${new Date().toISOString()}] Session ${session.id} ping`);
      const pongW = new BinaryWriter();
      pongW.writeInt(0x347773c5);
      pongW.writeLong(reqMsgId);
      pongW.writeLong(pingId);
      return pongW.getBytes();
    }

    case 0x58e4a740: { // rpc_drop_answer
      // Return rpc_answer_dropped_running — we don't track pending RPCs
      const rdaW = new BinaryWriter();
      rdaW.writeInt(0xcd78e586); // rpc_answer_dropped_running
      return rdaW.getBytes();
    }

    case 0xf2f2330a: { // langpack.getLangPack
      const lpReader1 = new BinaryReader(data);
      lpReader1.offset = 4;
      const langPackName1 = readTlString(lpReader1);
      // console.log(`[${new Date().toISOString()}] Session ${session.id} langpack.getLangPack (pack=${langPackName1})`);
      return buildLangPackDifference(langPackName1);
    }

    case 0xefea3803: { // langpack.getStrings
      const lpReader2 = new BinaryReader(data);
      lpReader2.offset = 4;
      const langPackName2 = readTlString(lpReader2);
      readTlString(lpReader2); // lang_code
      lpReader2.readInt() >>> 0; // vector constructor
      const keyCount = lpReader2.readInt();
      const keys: string[] = [];
      for (let i = 0; i < keyCount; i++) keys.push(readTlString(lpReader2));
      // console.log(`[${new Date().toISOString()}] Session ${session.id} langpack.getStrings (pack=${langPackName2}, ${keyCount} keys)`);
      return buildLangPackStringsResponse(langPackName2, keys);
    }

    case 0x6a596502: { // langpack.getLanguage
      // console.log(`[${new Date().toISOString()}] Session ${session.id} langpack.getLanguage`);
      return buildLangPackLanguage();
    }

    case 0x42c6978f: { // langpack.getLanguages
      // console.log(`[${new Date().toISOString()}] Session ${session.id} langpack.getLanguages`);
      return buildEmptyVector();
    }

    case 0xcd984aa5: { // langpack.getDifference
      const lpReader3 = new BinaryReader(data);
      lpReader3.offset = 4;
      const langPackName3 = readTlString(lpReader3);
      // console.log(`[${new Date().toISOString()}] Session ${session.id} langpack.getDifference (pack=${langPackName3})`);
      return buildLangPackDifference(langPackName3);
    }

    case 0x25d218ec: // updates.getDifference (layer <166)
    case 0x19c2f763: // updates.getDifference (layer 166+)
    case 0x25939651: { // updates.getDifference (layer 224+)
      console.log(`[${new Date().toISOString()}] Session ${session.id} updates.getDifference (userId=${session.userId})`);
      if (!session.userId) return buildRpcErrorObject(401, 'AUTH_KEY_UNREGISTERED');
      // Also push pending incoming calls on getDifference (reconnect scenario)
      const diffUserId = session.userId;
      for (const [, pendingCall] of _callsMap) {
        if (pendingCall.participantId === diffUserId && pendingCall.state === 'waiting') {
          setTimeout(() => {
            const requestedBuf = _buildPhoneCallRequested(pendingCall, pendingCall.participantAccessHash);
            const pendingUpdateBuf = _buildUpdatePhoneCall(requestedBuf);
            const pendingEnvelope = buildLiveUpdatesEnvelope(
              [pendingUpdateBuf],
              [String(pendingCall.adminId), String(pendingCall.participantId)],
              [],
            );
            ctx.broadcastToUser(diffUserId, pendingEnvelope);
            console.log(`[${new Date().toISOString()}] Late-join (diff): pushed pending PhoneCallRequested to userId=${diffUserId} (callId=${pendingCall.id.toString(16)})`);
          }, 1000);
        }
      }
      return buildUpdatesDifference(data, session.userId);
    }

    case 0x62d6b459: { // msgs_ack
      return null;
    }

    case 0xcb9f372d: { // invokeAfterMsg
      // console.log(`[${new Date().toISOString()}] Session ${session.id} invokeAfterMsg`);
      return handleTlRequest(data.slice(12), session, reqMsgId, ctx);
    }

    case 0xbf9459b7: { // invokeWithoutUpdates
      // console.log(`[${new Date().toISOString()}] Session ${session.id} invokeWithoutUpdates`);
      return handleTlRequest(data.slice(4), session, reqMsgId, ctx);
    }

    case 0x3072cfa1: { // gzip_packed
      // console.log(`[${new Date().toISOString()}] Session ${session.id} gzip_packed`);
      try {
        const reader = new BinaryReader(data);
        reader.offset = 4;
        const firstByte = reader.readByte();
        let len: number;
        if (firstByte <= 253) {
          len = firstByte;
        } else {
          const b = reader.readBytes(3);
          len = b[0] | (b[1] << 8) | (b[2] << 16);
        }
        const gzippedData = reader.readBytes(len);
        const decompressed = Buffer.from(gunzipSync(gzippedData));
        console.log(`[${new Date().toISOString()}] Session ${session.id} gzip decompressed: ${len} -> ${decompressed.length} bytes, inner constructor: 0x${decompressed.readUInt32LE(0).toString(16)}`);
        return handleTlRequest(decompressed, session, reqMsgId, ctx);
      } catch (e) {
        console.error(`[${new Date().toISOString()}] Session ${session.id} gzip decompress error:`, (e as Error).message);
        return null;
      }
    }

    // ========== PRIORITY 1: Main UI API Stubs ==========

    case 0xb60f5918: { // users.getFullUser
      const request = parseGetFullUserRequest(data, session);
      const selfId = session.userId || SEED_USER_ID;
      const targetUserId = request?.userId || String(selfId);
      console.log(`[${new Date().toISOString()}] Session ${session.id} users.getFullUser target=${targetUserId} viewer=${selfId}`);
      const result = buildUserFullForUser(session, undefined, targetUserId);
      console.log(`[${new Date().toISOString()}]   → response size=${result.length} bytes`);
      return result;
    }

    case 0x0d91a548: { // users.getUsers
      // console.log(`[${new Date().toISOString()}] Session ${session.id} users.getUsers`);
      const request = parseGetUsersRequest(data, session);
      if (!request || request.length === 0) {
        return buildUsersVector(session);
      }
      return buildUsersVectorForIds(session, undefined, request.map(({ userId }) => userId));
    }

    case 0xefd48c89: { // messages.getDialogFilters
      // console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getDialogFilters`);
      return buildDialogFilters();
    }

    case 0xa0f4cb4f: { // messages.getDialogs
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getDialogs`);
      const dialogsSelfId = session.userId || SEED_USER_ID;
      return buildDialogsFromDb(dialogsSelfId);
    }

    case 0x6628562c: { // account.updateStatus
      const statusSelfId = session.userId || SEED_USER_ID;
      const statusReader = new BinaryReader(data);
      statusReader.readInt(); // constructor
      const offlineCtor = statusReader.readInt() >>> 0;
      const isOffline = offlineCtor === 0xbc799737;
      if (isOffline) {
        messageStore.setUserOffline(statusSelfId);
      } else {
        messageStore.setUserOnline(statusSelfId);
      }
      const allUsers = messageStore.getAllUsers();
      for (const user of allUsers) {
        if (user.id !== statusSelfId) {
          const statusVisible = isFieldVisibleByPrivacy(statusSelfId, user.id, 'statusTimestamp');
          const statusUpdate = buildUpdateUserStatus(statusSelfId, isOffline, statusVisible);
          ctx.broadcastToUser(user.id, statusUpdate);
        }
      }
      return buildBoolTrue();
    }

    case 0xec86017a: { // account.registerDevice
      console.log(`[${new Date().toISOString()}] Session ${session.id} account.registerDevice (no-op)`);
      return buildBoolTrue();
    }

    case 0x6a0d3206: { // account.unregisterDevice
      // console.log(`[${new Date().toISOString()}] Session ${session.id} account.unregisterDevice`);
      return buildBoolTrue();
    }

    case 0x735787a8: { // help.getCountriesList
      console.log(`[${new Date().toISOString()}] Session ${session.id} help.getCountriesList`);
      return buildCountriesListEmpty();
    }

    case 0x2ca51fd1: { // help.getTermsOfServiceUpdate
      console.log(`[${new Date().toISOString()}] Session ${session.id} help.getTermsOfServiceUpdate`);
      return buildTermsOfServiceUpdateEmpty();
    }

    case 0xe470bcfd: { // messages.getPeerDialogs
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getPeerDialogs`);
      const peerDialogsSelfId = session.userId || SEED_USER_ID;
      const requestedPeerKeys = parsePeerDialogsRequest(data);
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getPeerDialogs peers: ${JSON.stringify(requestedPeerKeys)}`);
      return buildPeerDialogsForPeers(requestedPeerKeys, peerDialogsSelfId);
    }

    case 0x4423e6c5: { // messages.getHistory
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getHistory`);
      const histSelfId = session.userId || SEED_USER_ID;
      const request = parseHistoryRequest(data);
      if (request?.peerKey) {
        const storedMessages = listStoredMessagesAsFixtureForUser(request.peerKey, histSelfId);
        if (storedMessages.length > 0) {
          return buildGetMessagesResponse(storedMessages, null, histSelfId);
        }
      }
      return buildMessagesSliceEmpty();
    }

    case 0x998ab009: { // messages.getSavedHistory
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getSavedHistory`);
      const savedSelfId = session.userId || SEED_USER_ID;
      const savedPeerKey = `user:${savedSelfId}`;
      const storedMessages = listStoredMessagesAsFixtureForUser(savedPeerKey, savedSelfId);
      if (storedMessages.length > 0) {
        return buildGetMessagesResponse(storedMessages, null, savedSelfId);
      }
      return buildMessagesEmpty();
    }

    case 0x63c66506: { // messages.getMessages
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getMessages`);
      const messageIds = parseGetMessagesRequest(data);
      if (!messageIds || messageIds.length === 0) {
        return buildGetMessagesResponse([]);
      }

      const selfId = session.userId || SEED_USER_ID;
      const foundMessages: FixtureMessage[] = [];

      for (const msgId of messageIds) {
        const stored = messageStore.getMessageForUser(msgId, selfId);
        if (stored) {
          const isSavedMessages = stored.peerKey === `user:${selfId}`;
          foundMessages.push({
            id: stored.messageId,
            peerKey: stored.peerKey,
            date: stored.date,
            text: stored.text,
            className: stored.actionType ? 'MessageService' : 'Message',
            out: isSavedMessages ? false : stored.isOutgoing,
            post: stored.post,
            fromPeerKey: isSavedMessages ? undefined : stored.fromPeerKey,
            savedPeerKey: isSavedMessages ? `user:${selfId}` : undefined,
            editDate: stored.editDate,
            replyToMsgId: stored.replyToMsgId,
            quoteText: stored.quoteText,
            quoteOffset: stored.quoteOffset,
            mediaId: stored.mediaId,
            fwdFromPeerKey: stored.fwdFromPeerKey,
            fwdFromName: stored.fwdFromName,
            fwdDate: stored.fwdDate,
            action: buildActionForFixture(stored.peerKey, stored.actionType, stored.text, stored.mediaId),
            reactions: aggregateReactions(selfId, stored.peerKey, stored.messageId, selfId),
          });
        }
      }

      return buildGetMessagesResponse(foundMessages, null, selfId);
    }

    case 0x29ee847a: { // messages.search
      const searchSelfId = session.userId || SEED_USER_ID;
      const searchReq = parseSearchRequest(data);
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.search (q="${searchReq?.query}", peer=${searchReq?.peerKey}, filter=${searchReq?.filterType}, limit=${searchReq?.limit})`);
      if (searchReq) {
        // Unsupported filter types — return empty immediately
        if (searchReq.filterType === 'url' || searchReq.filterType === 'pinned' || searchReq.filterType === 'other') {
          return buildMessagesEmpty();
        }
        const hasMedia = searchReq.filterType === 'photos' || searchReq.filterType === 'video'
          || searchReq.filterType === 'photo_video' || searchReq.filterType === 'document'
          || searchReq.filterType === 'gif' || searchReq.filterType === 'music'
          || searchReq.filterType === 'voice';
        const actionType = searchReq.filterType === 'chat_photos' ? 'chat_edit_photo' : undefined;
        const results = messageStore.searchMessages(searchSelfId, searchReq.query, {
          peerKey: searchReq.peerKey,
          offsetId: searchReq.offsetId,
          limit: Math.min(searchReq.limit || 20, 100),
          hasMedia: hasMedia || undefined,
          actionType,
        });
        if (results.length > 0) {
          const fixtureMessages: FixtureMessage[] = results.map((msg) => ({
            id: msg.messageId,
            peerKey: msg.peerKey,
            date: msg.date,
            text: msg.text,
            className: msg.actionType ? 'MessageService' : 'Message',
            out: msg.isOutgoing,
            post: msg.post,
            fromPeerKey: msg.fromPeerKey,
            editDate: msg.editDate,
            replyToMsgId: msg.replyToMsgId,
            quoteText: msg.quoteText,
            quoteOffset: msg.quoteOffset,
            mediaId: msg.mediaId,
            fwdFromPeerKey: msg.fwdFromPeerKey,
            fwdFromName: msg.fwdFromName,
            fwdDate: msg.fwdDate,
            action: buildActionForFixture(msg.peerKey, msg.actionType, msg.text, msg.mediaId),
          }));
          return buildGetMessagesResponse(fixtureMessages, null, searchSelfId);
        }
      }
      return buildMessagesEmpty();
    }

    case 0xf516760b: // messages.getScheduledHistory
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getScheduledHistory`);
      return buildMessagesEmpty();

    case 0x3d6ce850: { // messages.getSponsoredMessages
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getSponsoredMessages`);
      return buildSponsoredMessagesEmpty();
    }

    case 0x78499170: { // stories.getPeerMaxIDs
      console.log(`[${new Date().toISOString()}] Session ${session.id} stories.getPeerMaxIDs`);
      const peers = parsePeerVectorRequest(data) || [];
      return buildRecentStoriesVector(peers.length);
    }

    case 0x08736a09: { // channels.getFullChannel
      console.log(`[${new Date().toISOString()}] Session ${session.id} channels.getFullChannel`);
      const request = parseGetFullChannelRequest(data);
      return buildChannelFullEmpty(request?.channelId);
    }

    case 0xad8c9a23: { // channels.getMessages
      console.log(`[${new Date().toISOString()}] Session ${session.id} channels.getMessages`);
      return buildGetMessagesResponse([]);
    }

    case 0x545cd15a: { // messages.sendMessage
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.sendMessage`);
      const request = parseSendMessageRequest(data);
      if (!request?.peerKey) {
        return buildRpcErrorObject(400, 'MSG_OPTION_UNSUPPORTED');
      }

      const peerErr = validatePeerKey(request.peerKey);
      if (peerErr) return buildRpcErrorObject(400, peerErr);
      const msgErr = validateMessageText(request.message);
      if (msgErr) return buildRpcErrorObject(400, msgErr);

      const selfId = session.userId || SEED_USER_ID;
      if (!messageLimiter.check(String(selfId))) {
        return buildRpcErrorObject(420, 'FLOOD_WAIT_60');
      }

      const isSavedMessages = request.peerKey === `user:${selfId}`;
      const isP2P = request.peerKey.startsWith('user:') && !isSavedMessages;
      const isGroupChat = request.peerKey.startsWith('chat:') || request.peerKey.startsWith('channel:');
      const senderPeerKey = isGroupChat ? `user:${selfId}` : (request.peerKey.startsWith('channel:') ? undefined : `user:${selfId}`);

      // Delete draft for this peer if exists
      messageStore.deleteDraft(selfId, request.peerKey);

      const storedMessage = messageStore.appendOutgoingMessage(selfId, {
        peerKey: request.peerKey,
        text: request.message,
        clientRandomId: request.randomId,
        seedMaxMessageId: 0,
        fromPeerKey: isSavedMessages ? undefined : senderPeerKey,
        post: request.peerKey.startsWith('channel:') && !messageStore.getChatById(Number(request.peerKey.split(':')[1]))?.isMegagroup,
        replyToMsgId: request.replyToMsgId,
        quoteText: request.quoteText,
        quoteOffset: request.quoteOffset,
      });

      const messageFixture = getStoredMessageAsFixture(request.peerKey, storedMessage.messageId, selfId);

      const userIds: string[] = [String(selfId)];
      const chatIds: string[] = [];
      if (messageFixture) {
        collectEntityIdsFromPeerKey(messageFixture.peerKey, userIds, chatIds);
      }

      const sharedUpdates: Buffer[] = [];
      if (messageFixture) {
        sharedUpdates.push(buildUpdateNewMessage(messageFixture, storedMessage.updatePts, storedMessage.updatePtsCount));
      }

      if (isSavedMessages) {
        const readInfo = messageStore.appendUpdateEvent_ReadHistory(selfId, request.peerKey, storedMessage.messageId);
        if (readInfo) {
          sharedUpdates.push(buildUpdateReadHistoryInbox(request.peerKey, storedMessage.messageId, readInfo.pts, readInfo.ptsCount, selfId));
        }
        const outboxReadInfo = messageStore.appendUpdateEvent_ReadHistoryOutbox(selfId, request.peerKey, storedMessage.messageId);
        if (outboxReadInfo) {
          sharedUpdates.push(buildUpdateReadHistoryOutbox(request.peerKey, storedMessage.messageId, outboxReadInfo.pts, outboxReadInfo.ptsCount));
        }
      }

      ctx.broadcastSessionUpdates(session, buildLiveUpdatesEnvelope(sharedUpdates, userIds, chatIds));

      if (isP2P) {
        const recipientIdStr = request.peerKey.replace('user:', '');
        const recipientId = Number(recipientIdStr);
        const recipientPeerKey = `user:${selfId}`;

        let recipientReplyToMsgId: number | undefined;
        if (request.replyToMsgId) {
          const [resolved] = messageStore.resolveRecipientMessageIds(
            selfId, request.peerKey, recipientId, recipientPeerKey, [request.replyToMsgId],
          );
          recipientReplyToMsgId = resolved;
        }

        const recipientMessage = messageStore.appendOutgoingMessage(recipientId, {
          peerKey: recipientPeerKey,
          text: request.message,
          clientRandomId: `recv_${request.randomId}`,
          seedMaxMessageId: 0,
          fromPeerKey: `user:${selfId}`,
          post: false,
          replyToMsgId: recipientReplyToMsgId,
          quoteText: request.quoteText,
          quoteOffset: request.quoteOffset,
        });
        messageStore.markMessageIncoming(recipientId, recipientPeerKey, recipientMessage.messageId);

        const recipientFixture = getStoredMessageAsFixture(recipientPeerKey, recipientMessage.messageId, recipientId);
        if (recipientFixture) {
          const recipientUserIds = [String(selfId), recipientIdStr];
          const recipientUpdates: Buffer[] = [
            buildUpdateNewMessage(recipientFixture, recipientMessage.updatePts, recipientMessage.updatePtsCount),
          ];
          ctx.broadcastToUser(
            recipientId,
            buildLiveUpdatesEnvelope(recipientUpdates, recipientUserIds, []),
          );
        }
      }

      // Group/channel: broadcast to all other participants
      if (isGroupChat) {
        const chatId = Number(request.peerKey.split(':')[1]);
        const participants = messageStore.getChatParticipants(chatId);
        for (const p of participants) {
          if (p.userId === selfId) continue;
          // Store the message for each participant
          const participantMsg = messageStore.appendOutgoingMessage(p.userId, {
            peerKey: request.peerKey,
            text: request.message,
            clientRandomId: `group_${request.randomId}_${p.userId}`,
            seedMaxMessageId: 0,
            fromPeerKey: `user:${selfId}`,
            post: storedMessage.post,
            replyToMsgId: request.replyToMsgId,
            quoteText: request.quoteText,
            quoteOffset: request.quoteOffset,
          });
          messageStore.markMessageIncoming(p.userId, request.peerKey, participantMsg.messageId);
          const pFixture = getStoredMessageAsFixture(request.peerKey, participantMsg.messageId, p.userId);
          if (pFixture) {
            const pUserIds = [String(selfId), String(p.userId)];
            const pChatIds = [request.peerKey.split(':')[1]];
            ctx.broadcastToUser(
              p.userId,
              buildLiveUpdatesEnvelopeWithChats(
                [buildUpdateNewMessage(pFixture, participantMsg.updatePts, participantMsg.updatePtsCount)],
                pUserIds,
                [chatId],
                p.userId,
              ),
            );
          }
        }
      }

      const senderUpdates: Buffer[] = [
        buildUpdateMessageID(storedMessage.messageId, request.randomId),
        ...sharedUpdates,
      ];
      return buildLiveUpdatesEnvelope(senderUpdates, userIds, chatIds);
    }

    case 0x51e842e1: { // messages.editMessage
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.editMessage`);
      const editSelfId = session.userId || SEED_USER_ID;
      const editReq = parseEditMessageRequest(data);
      if (!editReq?.peerKey || !editReq.messageId || !editReq.newText) {
        return buildRpcErrorObject(400, 'MESSAGE_EDIT_INVALID');
      }
      const editPeerErr = validatePeerKey(editReq.peerKey);
      if (editPeerErr) return buildRpcErrorObject(400, editPeerErr);
      const editTextErr = validateMessageText(editReq.newText);
      if (editTextErr) return buildRpcErrorObject(400, editTextErr);

      const editResult = messageStore.editMessage(editSelfId, editReq.peerKey, editReq.messageId, editReq.newText);
      if (!editResult) {
        return buildRpcErrorObject(400, 'MESSAGE_ID_INVALID');
      }

      const editFixture = getStoredMessageAsFixture(editReq.peerKey, editReq.messageId, editSelfId);
      if (!editFixture) {
        return buildRpcErrorObject(400, 'MESSAGE_ID_INVALID');
      }

      const editUserIds: string[] = [String(editSelfId)];
      const editChatIds: string[] = [];
      collectEntityIdsFromPeerKey(editFixture.peerKey, editUserIds, editChatIds);
      if (editFixture.fromPeerKey) collectEntityIdsFromPeerKey(editFixture.fromPeerKey, editUserIds, editChatIds);

      const editUpdate = buildUpdateEditMessage(editFixture, editResult.updatePts, editResult.updatePtsCount);
      ctx.broadcastSessionUpdates(session, buildLiveUpdatesEnvelope([editUpdate], editUserIds, editChatIds));

      const isP2PEdit = editReq.peerKey.startsWith('user:') && editReq.peerKey !== `user:${editSelfId}`;
      if (isP2PEdit) {
        const recipientId = Number(editReq.peerKey.replace('user:', ''));
        const recipientPeerKey = `user:${editSelfId}`;
        // Resolve sender's messageId to recipient's messageId via clientRandomId
        const [recipientMsgId] = messageStore.resolveRecipientMessageIds(
          editSelfId, editReq.peerKey, recipientId, recipientPeerKey, [editReq.messageId],
        );
        const recipientEdit = recipientMsgId
          ? messageStore.editMessage(recipientId, recipientPeerKey, recipientMsgId, editReq.newText)
          : undefined;
        if (recipientEdit) {
          const recipientFixture = getStoredMessageAsFixture(recipientPeerKey, recipientMsgId, recipientId);
          if (recipientFixture) {
            const recipientUserIds = [String(editSelfId), String(recipientId)];
            const recipientEditUpdate = buildUpdateEditMessage(recipientFixture, recipientEdit.updatePts, recipientEdit.updatePtsCount);
            ctx.broadcastToUser(recipientId, buildLiveUpdatesEnvelope([recipientEditUpdate], recipientUserIds, []));
          }
        }
      }

      return buildLiveUpdatesEnvelope([editUpdate], editUserIds, editChatIds);
    }

    case 0xe58e95d2: { // messages.deleteMessages
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.deleteMessages (userId=${session.userId})`);
      const delSelfId = session.userId || SEED_USER_ID;
      const delReq = parseDeleteMessagesRequest(data);
      console.log(`[DELETE] revoke=${delReq?.revoke}, messageIds=${JSON.stringify(delReq?.messageIds)}`);
      if (!delReq?.messageIds.length) {
        return buildAffectedMessages(messageStore.getUpdateState(delSelfId).pts, 0);
      }
      const delIdsErr = validateMessageIds(delReq.messageIds);
      if (delIdsErr) return buildRpcErrorObject(400, delIdsErr);

      const firstMsg = messageStore.findMessageInAllPeers(delSelfId, delReq.messageIds[0]);
      console.log(`[DELETE] firstMsg peerKey=${firstMsg?.peerKey}, clientRandomId=${firstMsg?.clientRandomId}`);
      if (!firstMsg) {
        return buildAffectedMessages(messageStore.getUpdateState(delSelfId).pts, 0);
      }

      // Resolve recipient messageIds BEFORE deleting sender's copies (need clientRandomId)
      let recipientId: number | undefined;
      let recipientPeerKey: string | undefined;
      let recipientMsgIds: number[] = [];
      if (delReq.revoke) {
        const isP2PDel = firstMsg.peerKey.startsWith('user:') && firstMsg.peerKey !== `user:${delSelfId}`;
        console.log(`[DELETE] isP2P=${isP2PDel}`);
        if (isP2PDel) {
          recipientId = Number(firstMsg.peerKey.replace('user:', ''));
          recipientPeerKey = `user:${delSelfId}`;
          recipientMsgIds = messageStore.resolveRecipientMessageIds(
            delSelfId, firstMsg.peerKey, recipientId, recipientPeerKey, delReq.messageIds,
          );
          console.log(`[DELETE] recipientId=${recipientId}, recipientPeerKey=${recipientPeerKey}, recipientMsgIds=${JSON.stringify(recipientMsgIds)}`);
        }
      }

      const senderStateBefore = messageStore.getUpdateState(delSelfId);
      console.log(`[DELETE] sender(${delSelfId}) pts BEFORE delete: ${senderStateBefore.pts}`);
      const delResult = messageStore.deleteMessages(delSelfId, firstMsg.peerKey, delReq.messageIds);
      console.log(`[DELETE] sender deleteResult: pts=${delResult?.updatePts}, ptsCount=${delResult?.updatePtsCount}`);
      if (!delResult) {
        return buildAffectedMessages(messageStore.getUpdateState(delSelfId).pts, 0);
      }

      const delUpdate = buildUpdateDeleteMessages(delReq.messageIds, delResult.updatePts, delResult.updatePtsCount);
      ctx.broadcastToUser(delSelfId, buildLiveUpdatesEnvelope([delUpdate], [], []));

      // Now delete recipient's copies and broadcast
      if (recipientId !== undefined && recipientPeerKey && recipientMsgIds.length > 0) {
        const recipientStateBefore = messageStore.getUpdateState(recipientId);
        console.log(`[DELETE] recipient(${recipientId}) pts BEFORE delete: ${recipientStateBefore.pts}`);
        const recipientDel = messageStore.deleteMessages(recipientId, recipientPeerKey, recipientMsgIds);
        console.log(`[DELETE] recipient deleteResult: pts=${recipientDel?.updatePts}, ptsCount=${recipientDel?.updatePtsCount}`);
        if (recipientDel) {
          const recipientDelUpdate = buildUpdateDeleteMessages(recipientMsgIds, recipientDel.updatePts, recipientDel.updatePtsCount);
          console.log(`[DELETE] Broadcasting delete to recipient ${recipientId}: msgIds=${JSON.stringify(recipientMsgIds)}, pts=${recipientDel.updatePts}`);
          ctx.broadcastToUser(recipientId, buildLiveUpdatesEnvelope([recipientDelUpdate], [], []));
        }
      } else if (delReq.revoke) {
        console.log(`[DELETE] SKIPPED recipient broadcast: recipientId=${recipientId}, recipientPeerKey=${recipientPeerKey}, recipientMsgIds=${JSON.stringify(recipientMsgIds)}`);
      }

      return buildAffectedMessages(delResult.updatePts, delResult.updatePtsCount);
    }

    case 0x58943ee2: { // messages.setTyping
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.setTyping`);
      const typingSelfId = session.userId || SEED_USER_ID;
      const typingReq = parseSetTypingRequest(data);
      if (typingReq?.peerKey) {
        const isP2PTyping = typingReq.peerKey.startsWith('user:') && typingReq.peerKey !== `user:${typingSelfId}`;
        if (isP2PTyping) {
          const targetUserId = Number(typingReq.peerKey.replace('user:', ''));
          ctx.broadcastToUser(targetUserId, buildUpdateUserTyping(typingSelfId, typingReq.actionConstructor));
        }
      }
      return buildBoolTrue();
    }

    case 0x0e306d3a: { // messages.readHistory
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.readHistory`);
      const request = parseReadHistoryRequest(data);
      if (!request) {
        return buildRpcErrorObject(400, 'MSG_OPTION_UNSUPPORTED');
      }

      const readSelfId = session.userId || SEED_USER_ID;
      const state = messageStore.markHistoryRead(readSelfId, request.peerKey, request.maxId);
      ctx.broadcastSessionUpdates(session, buildLiveReadHistoryUpdates(
        request.peerKey,
        request.maxId,
        state.updatePts,
        state.updatePtsCount,
        readSelfId,
      ));
      // Notify the other side that their outbox was read
      if (request.peerKey.startsWith('user:') && request.peerKey !== `user:${readSelfId}`) {
        const otherUserId = Number(request.peerKey.replace('user:', ''));
        const otherPeerKey = `user:${readSelfId}`;
        const outboxState = messageStore.appendUpdateEvent_ReadHistoryOutbox(otherUserId, otherPeerKey, request.maxId);
        const outboxUpdate = buildUpdateReadHistoryOutbox(otherPeerKey, request.maxId, outboxState.pts, outboxState.ptsCount);
        ctx.broadcastToUser(otherUserId, buildLiveUpdatesEnvelope([outboxUpdate], [String(readSelfId)], []));
      } else if (request.peerKey.startsWith('chat:')) {
        const chatId = Number(request.peerKey.split(':')[1]);
        const participants = messageStore.getChatParticipants(chatId);
        for (const p of participants) {
          if (p.userId === readSelfId) continue;
          const outboxState = messageStore.appendUpdateEvent_ReadHistoryOutbox(p.userId, request.peerKey, request.maxId);
          const outboxUpdate = buildUpdateReadHistoryOutbox(request.peerKey, request.maxId, outboxState.pts, outboxState.ptsCount);
          ctx.broadcastToUser(p.userId, buildLiveUpdatesEnvelope([outboxUpdate], [], []));
        }
      }
      return buildAffectedMessages(state.updatePts, state.updatePtsCount);
    }

    case 0xcc104937: { // channels.readHistory
      console.log(`[${new Date().toISOString()}] Session ${session.id} channels.readHistory`);
      const request = parseChannelReadHistoryRequest(data);
      if (!request) {
        return buildRpcErrorObject(400, 'MSG_OPTION_UNSUPPORTED');
      }

      const chanReadSelfId = session.userId || SEED_USER_ID;
      messageStore.markHistoryRead(chanReadSelfId, request.peerKey, request.maxId);
      return buildBoolTrue();
    }

    case 0xd6b94df2: // messages.getPinnedDialogs (newer layer)
    case 0xe04232f3: { // messages.getPinnedDialogs
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getPinnedDialogs`);
      return buildPinnedDialogs(session.userId);
    }

    case 0x1fb33026: { // help.getNearestDc
      console.log(`[${new Date().toISOString()}] Session ${session.id} help.getNearestDc`);
      return buildNearestDc();
    }

    case 0x5dd69e12: { // contacts.getContacts
      console.log(`[${new Date().toISOString()}] Session ${session.id} contacts.getContacts`);
      const selfId = session.userId || SEED_USER_ID;
      return buildContactsFromDb(selfId);
    }

    case 0x11f812d8: { // contacts.search
      console.log(`[${new Date().toISOString()}] Session ${session.id} contacts.search`);
      const searchReader = new BinaryReader(data);
      searchReader.offset = 4;
      const query = readTlString(searchReader);
      const selfId = session.userId || SEED_USER_ID;
      console.log(`[${new Date().toISOString()}] contacts.search query="${query}" selfId=${selfId}`);
      return buildContactsFound(query, selfId);
    }

    case 0x21202222: { // messages.getDialogUnreadMarks
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getDialogUnreadMarks`);
      return buildEmptyVector();
    }

    case 0x12b3ad31: { // account.getNotifySettings
      console.log(`[${new Date().toISOString()}] Session ${session.id} account.getNotifySettings`);
      return buildPeerNotifySettings();
    }

    case 0xe320c158: { // account.getAuthorizations
      console.log(`[${new Date().toISOString()}] Session ${session.id} account.getAuthorizations`);
      const authzUserId = session.userId || SEED_USER_ID;
      const sessions = messageStore.getSessionsForUser(authzUserId);
      if (sessions.length === 0) {
        return buildAuthorizationsEmpty();
      }
      const currentKeyHex = session.authKey ? getKeyIdHex(session.authKey) : undefined;
      return buildAuthorizations(sessions, currentKeyHex);
    }

    case 0xc0977421: { // help.getPromoData
      console.log(`[${new Date().toISOString()}] Session ${session.id} help.getPromoData`);
      return buildPromoDataEmpty();
    }

    case 0x07967d36: { // account.getWallPapers
      console.log(`[${new Date().toISOString()}] Session ${session.id} account.getWallPapers`);
      return buildWallPapersNotModified();
    }

    case 0x150b3b4c: // messages.getStickerSet (old)
    case 0xc8a0ec74: { // messages.getStickerSet (new)
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getStickerSet`);
      const ssReader = new BinaryReader(data);
      ssReader.offset = 4; // skip method constructor
      const ssInputConstructor = ssReader.readInt() >>> 0;
      console.log(`[STICKERSET] inputConstructor=0x${ssInputConstructor.toString(16)}`);

      // Map inputStickerSet constructors to capture file type names
      const inputStickerSetTypeMap: Record<number, string> = {
        0x028703c8: 'AnimatedEmoji',
        0x0cde3739: 'AnimatedEmojiAnimations',
        0xc88b3b02: 'PremiumGifts',
        0x1cf671a0: 'TonGifts',
        0x04c4d4ce: 'EmojiGenericAnimations',
        0x29d0f5ee: 'EmojiDefaultStatuses',
        0x44c1f8e9: 'EmojiDefaultTopicIcons',
        0x49748553: 'EmojiChannelDefaultStatuses',
      };

      if (ssInputConstructor === 0x9de7a269) { // inputStickerSetID
        const ssId = ssReader.readLong(false).toString();
        const captured = buildStickerSetFromCapture(ssId);
        if (captured) {
          console.log(`[STICKERSET] Serving captured set ${ssId} (${captured.length} bytes)`);
          return captured;
        }
        console.log(`[STICKERSET] NOT FOUND: ${ssId}`);
        return buildRpcErrorObject(400, 'STICKERSET_INVALID');
      } else if (ssInputConstructor === 0x861cc8a0) { // inputStickerSetShortName
        const shortName = readTlString(ssReader);
        const captured = buildStickerSetFromCaptureByShortName(shortName);
        if (captured) {
          console.log(`[STICKERSET] Serving captured set by shortName="${shortName}" (${captured.length} bytes)`);
          return captured;
        }
        console.log(`[STICKERSET] shortName="${shortName}" — not found, returning error`);
        return buildRpcErrorObject(400, 'STICKERSET_INVALID');
      } else if (ssInputConstructor === 0xe67f520e || ssInputConstructor === 0x79e21a53) { // inputStickerSetDice
        const emoticon = readTlString(ssReader);
        const captured = buildStickerSetFromCaptureByShortName(emoticon);
        if (captured) {
          console.log(`[STICKERSET] Serving dice set "${emoticon}" (${captured.length} bytes)`);
          return captured;
        }
        console.log(`[STICKERSET] Dice "${emoticon}" — not found, returning error`);
        return buildRpcErrorObject(400, 'STICKERSET_INVALID');
      } else if (inputStickerSetTypeMap[ssInputConstructor]) {
        const typeName = inputStickerSetTypeMap[ssInputConstructor];
        const captured = buildStickerSetFromCaptureByTypeName(typeName);
        if (captured) {
          console.log(`[STICKERSET] Serving ${typeName} set (${captured.length} bytes)`);
          return captured;
        }
        console.log(`[STICKERSET] ${typeName} — not captured, returning error`);
        return buildRpcErrorObject(400, 'STICKERSET_INVALID');
      } else if (ssInputConstructor === 0xffb62b95) { // inputStickerSetEmpty
        console.log(`[STICKERSET] Empty set requested`);
        return buildRpcErrorObject(400, 'STICKERSET_INVALID');
      } else {
        console.log(`[STICKERSET] unknown inputStickerSet constructor 0x${ssInputConstructor.toString(16)}`);
        return buildRpcErrorObject(400, 'STICKERSET_INVALID');
      }
    }

    case 0x72d4742c: { // help.getAppChangelog
      console.log(`[${new Date().toISOString()}] Session ${session.id} help.getAppChangelog`);
      return buildUpdatesEmpty();
    }

    case 0x973478b6: { // contacts.getTopPeers
      console.log(`[${new Date().toISOString()}] Session ${session.id} contacts.getTopPeers`);
      return buildTopPeersDisabled();
    }

    case 0x3671cf: { // contacts.getStatuses
      console.log(`[${new Date().toISOString()}] Session ${session.id} contacts.getStatuses`);
      return buildEmptyVector();
    }

    case 0x9a868f80: { // contacts.getBlocked
      console.log(`[${new Date().toISOString()}] Session ${session.id} contacts.getBlocked`);
      return buildBlockedEmpty();
    }

    case 0x18dea0ac: { // messages.getAvailableReactions
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getAvailableReactions`);
      return buildAvailableReactions();
    }

    case 0x1e91fc99: // messages.getSavedDialogs
    case 0xd63d94e0: { // messages.getPinnedSavedDialogs
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getSavedDialogs/getPinnedSavedDialogs`);
      return buildSavedDialogsEmpty();
    }

    case 0xeeb0d625: { // stories.getAllStories
      console.log(`[${new Date().toISOString()}] Session ${session.id} stories.getAllStories`);
      return buildAllStoriesEmpty();
    }

    case 0xbdf93428: { // messages.getDefaultTagReactions
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getDefaultTagReactions`);
      return buildReactionsEmpty();
    }

    case 0xeb2b4cf6: { // account.getGlobalPrivacySettings
      console.log(`[${new Date().toISOString()}] Session ${session.id} account.getGlobalPrivacySettings`);
      const selfId = session.userId || SEED_USER_ID;
      const settings = messageStore.getAllGlobalPrivacySettings(selfId);
      return buildGlobalPrivacySettingsFromDb(settings);
    }

    case 0x1edaaac2: { // account.setGlobalPrivacySettings
      console.log(`[${new Date().toISOString()}] Session ${session.id} account.setGlobalPrivacySettings`);
      const reader = new BinaryReader(data);
      reader.offset = 4; // skip constructor
      // settings:GlobalPrivacySettings
      const settingsCid = reader.readInt() >>> 0; // globalPrivacySettings constructor
      const sFlags = reader.readInt() >>> 0;
      const selfId = session.userId || SEED_USER_ID;
      messageStore.setGlobalPrivacySetting(selfId, 'archive_and_mute', (sFlags & (1 << 0)) ? '1' : '0');
      messageStore.setGlobalPrivacySetting(selfId, 'keep_archived_unmuted', (sFlags & (1 << 1)) ? '1' : '0');
      messageStore.setGlobalPrivacySetting(selfId, 'keep_archived_folders', (sFlags & (1 << 2)) ? '1' : '0');
      messageStore.setGlobalPrivacySetting(selfId, 'hide_read_marks', (sFlags & (1 << 3)) ? '1' : '0');
      messageStore.setGlobalPrivacySetting(selfId, 'new_noncontact_peers_require_premium', (sFlags & (1 << 4)) ? '1' : '0');
      messageStore.setGlobalPrivacySetting(selfId, 'display_gifts_button', (sFlags & (1 << 7)) ? '1' : '0');
      // skip noncontact_peers_paid_stars (flags.5 long) and disallowed_gifts (flags.6)
      const updatedSettings = messageStore.getAllGlobalPrivacySettings(selfId);
      return buildGlobalPrivacySettingsFromDb(updatedSettings);
    }

    case 0x16fcc2cb: { // messages.getAttachMenuBots
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getAttachMenuBots`);
      return buildAttachMenuBotsNotModified();
    }

    case 0x9f07c728: // account.getContactSignUpNotification
      console.log(`[${new Date().toISOString()}] Session ${session.id} account.getContactSignUpNotification`);
      return buildBoolFalse();

    case 0x53577479: { // account.getNotifyExceptions
      console.log(`[${new Date().toISOString()}] Session ${session.id} account.getNotifyExceptions`);
      return buildUpdatesEmpty();
    }

    case 0x35a0e062: // messages.getEmojiKeywords
    case 0x1508b6af: { // messages.getEmojiKeywordsDifference
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getEmojiKeywords/Difference`);
      return buildEmojiKeywordsDifference();
    }

    case 0xd5b10c26: { // messages.getEmojiURL
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getEmojiURL`);
      return buildEmojiURL();
    }

    case 0xbb8125ba: { // messages.getTopReactions
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getTopReactions`);
      return buildTopReactions();
    }

    case 0x39461db2: { // messages.getRecentReactions
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getRecentReactions`);
      return buildRecentReactions();
    }

    case 0x658b7188: { // messages.getDefaultHistoryTTL
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getDefaultHistoryTTL`);
      return buildDefaultHistoryTTL();
    }

    case 0x3637e05b: { // messages.getSavedReactionTags
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getSavedReactionTags`);
      return buildSavedReactionTagsEmpty();
    }

    case 0xd483f2a8: { // messages.getQuickReplies
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getQuickReplies`);
      return buildQuickRepliesEmpty();
    }

    case 0xdea20a39: { // messages.getAvailableEffects
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getAvailableEffects`);
      return buildAvailableEffectsEmpty();
    }

    case 0x472455aa: { // messages.getPaidReactionPrivacy
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getPaidReactionPrivacy`);
      return buildUpdatesEmpty();
    }

    case 0x570d6f6f: { // messages.getWebPagePreview
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getWebPagePreview`);
      return buildWebPagePreviewEmpty();
    }

    case 0x7ff3b806: // messages.saveDraft (Layer 198)
    case 0x54ae308e: { // messages.saveDraft (legacy)
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.saveDraft`);
      const draftSelfId = session.userId || SEED_USER_ID;
      const draftReq = parseSaveDraftRequest(data);
      if (draftReq?.peerKey) {
        messageStore.saveDraft(draftSelfId, draftReq.peerKey, draftReq.message, draftReq.replyToMsgId);
      }
      return buildBoolTrue();
    }

    case 0x8b9b4dae: { // account.getContentSettings
      console.log(`[${new Date().toISOString()}] Session ${session.id} account.getContentSettings`);
      return buildContentSettings();
    }

    case 0xdadbc950: { // account.getPrivacy
      const reader = new BinaryReader(data);
      reader.offset = 4; // skip constructor
      const keyConstructor = reader.readInt() >>> 0;
      const privacyKey = inputPrivacyKeyToString(keyConstructor);
      console.log(`[${new Date().toISOString()}] Session ${session.id} account.getPrivacy key=${privacyKey}`);
      const selfId = session.userId || SEED_USER_ID;
      const rules = messageStore.getPrivacyRules(selfId, privacyKey);
      if (rules.length === 0) {
        // Default: allowAll for most keys
        return buildPrivacyRules([{ ruleType: 'allowAll', value: [] }]);
      }
      return buildPrivacyRules(rules);
    }

    case 0xc9f81ce8: { // account.setPrivacy
      const reader = new BinaryReader(data);
      reader.offset = 4; // skip constructor
      const keyConstructor = reader.readInt() >>> 0;
      const privacyKey = inputPrivacyKeyToString(keyConstructor);
      console.log(`[${new Date().toISOString()}] Session ${session.id} account.setPrivacy key=${privacyKey}`);
      const selfId = session.userId || SEED_USER_ID;

      // Read rules vector: Vector<InputPrivacyRule>
      const vecCid = reader.readInt() >>> 0; // 0x1cb5c415
      const ruleCount = reader.readInt();
      const rules: Array<{ ruleType: string; value: number[] }> = [];
      for (let i = 0; i < ruleCount; i++) {
        const ruleCid = reader.readInt() >>> 0;
        const parsed = parseInputPrivacyRule(reader, ruleCid);
        if (parsed) rules.push(parsed);
      }

      messageStore.setPrivacyRules(selfId, privacyKey, rules);
      return buildPrivacyRules(rules);
    }

    case 0x548a30f5: { // account.getPassword
      console.log(`[${new Date().toISOString()}] Session ${session.id} account.getPassword`);
      return buildAccountPassword();
    }

    case 0xb8a0a1a8: { // messages.getAllStickers
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getAllStickers`);
      return buildAllStickersEmpty();
    }

    case 0xfbfca18f: { // messages.getEmojiStickers
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getEmojiStickers`);
      return buildEmojiStickers();
    }

    case 0xd9ab0f54: { // messages.getCustomEmojiDocuments
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getCustomEmojiDocuments`);
      const ceReader = new BinaryReader(data);
      ceReader.offset = 4; // skip constructor
      const ceVecCid = ceReader.readInt() >>> 0;
      const ceCount = ceReader.readInt();
      const docIds: string[] = [];
      for (let i = 0; i < ceCount; i++) {
        docIds.push(ceReader.readLong(false).toString());
      }
      console.log(`[CUSTOM-EMOJI] Requested ${ceCount} documents: ${docIds.slice(0, 5).join(', ')}${ceCount > 5 ? '...' : ''}`);
      // Build Vector<Document> from captured document blobs
      const docBufs: Buffer[] = [];
      const docsDir = _resolve(_dirname(_fileURLToPath(import.meta.url)), '../../data/documents');
      for (const docId of docIds) {
        const docPath = docsDir + '/' + docId + '.bin';
        if (_fsExists(docPath)) {
          docBufs.push(_fsRead(docPath));
        }
      }
      console.log(`[CUSTOM-EMOJI] Serving ${docBufs.length}/${ceCount} documents`);
      const ceW = new BinaryWriter();
      ceW.writeInt(0x1cb5c415); // vector
      ceW.writeInt(docBufs.length);
      for (const buf of docBufs) {
        ceW.writeBytes(buf);
      }
      return ceW.getBytes();
    }

    case 0xc78fe460: { // messages.installStickerSet
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.installStickerSet`);
      // messages.stickerSetInstallResultSuccess#38641628
      const w = new BinaryWriter();
      w.writeInt(0x38641628);
      return w.getBytes();
    }

    case 0xf96e55de: { // messages.uninstallStickerSet
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.uninstallStickerSet`);
      return buildBoolTrue();
    }

    case 0x0ecf6736: { // messages.getFeaturedEmojiStickers
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getFeaturedEmojiStickers`);
      return buildFeaturedEmojiStickers();
    }

    case 0x64780b14: { // messages.getFeaturedStickers
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getFeaturedStickers`);
      return buildFeaturedStickersNotModified();
    }

    case 0x9da9403b: { // messages.getRecentStickers
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getRecentStickers`);
      return buildRecentStickersNotModified();
    }

    case 0x5cf09635: { // messages.getSavedGifs
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getSavedGifs`);
      return buildSavedGifsNotModified();
    }

    case 0x04f1aaa9: { // messages.getFavedStickers
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getFavedStickers`);
      return buildFavedStickersNotModified();
    }

    case 0x49b30240: { // help.getTimezonesList
      console.log(`[${new Date().toISOString()}] Session ${session.id} help.getTimezonesList`);
      return buildTimezonesListEmpty();
    }

    case 0xc00ec7d3: { // payments.getStarsTopupOptions
      console.log(`[${new Date().toISOString()}] Session ${session.id} payments.getStarsTopupOptions`);
      return buildEmptyVector();
    }

    case 0x4ea9b3bf: { // payments.getStarsStatus
      console.log(`[${new Date().toISOString()}] Session ${session.id} payments.getStarsStatus`);
      return buildStarsStatusEmpty();
    }

    case 0x2e7b4543: { // account.getCollectibleEmojiStatuses
      console.log(`[${new Date().toISOString()}] Session ${session.id} account.getCollectibleEmojiStatuses`);
      return buildEmojiStatusesEmpty();
    }

    case 0xf578105: { // account.getRecentEmojiStatuses
      console.log(`[${new Date().toISOString()}] Session ${session.id} account.getRecentEmojiStatuses`);
      return buildEmojiStatusesEmpty();
    }

    case 0xc4563590: { // payments.getStarGifts
      console.log(`[${new Date().toISOString()}] Session ${session.id} payments.getStarGifts`);
      return buildStarGiftsEmpty();
    }

    case 0xa319e569: { // payments.getSavedStarGifts
      console.log(`[${new Date().toISOString()}] Session ${session.id} payments.getSavedStarGifts`);
      return buildSavedStarGiftsEmpty();
    }

    case 0xa5d0514d: { // payments.getStarGiftActiveAuctions
      console.log(`[${new Date().toISOString()}] Session ${session.id} payments.getStarGiftActiveAuctions`);
      return buildStarGiftActiveAuctionsEmpty();
    }

    case 0x5dd8c7b8: { // auth.initPasskeyLogin (unsupported)
      console.log(`[${new Date().toISOString()}] Session ${session.id} auth.initPasskeyLogin (unsupported)`);
      return buildRpcErrorObject(400, 'PASSKEY_NOT_SUPPORTED');
    }

    case 0xd5a5d3a1: { // messages.getStickers
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getStickers`);
      const sW = new BinaryWriter();
      sW.writeInt(0xf1749a22); // messages.stickersNotModified
      return sW.getBytes();
    }

    case 0x725afbbc: { // contacts.resolveUsername
      console.log(`[${new Date().toISOString()}] Session ${session.id} contacts.resolveUsername`);
      const reader = new BinaryReader(data);
      reader.offset = 4;
      reader.readInt(); // flags
      const username = readTlString(reader);
      console.log(`[${new Date().toISOString()}] resolveUsername: "${username}"`);
      return buildResolvedPeer(username);
    }

    case 0x8af94344: { // contacts.resolvePhone
      console.log(`[${new Date().toISOString()}] Session ${session.id} contacts.resolvePhone`);
      const reader = new BinaryReader(data);
      reader.offset = 4;
      const phone = readTlString(reader);
      console.log(`[${new Date().toISOString()}] resolvePhone: "${phone}"`);
      const user = messageStore.getUserByPhone(phone);
      if (!user) return buildRpcErrorObject(400, 'PHONE_NOT_OCCUPIED');
      return buildResolvedPeerForUser(user);
    }

    case 0x84be5b93: // account.updateNotifySettings
    case 0xa731e257: // messages.toggleDialogPin
    case 0x3b1adf37: { // messages.reorderPinnedDialogs
      console.log(`[${new Date().toISOString()}] Session ${session.id} updateNotifySettings/toggleDialogPin/reorderPinnedDialogs`);
      return buildBoolTrue();
    }

    case 0xb304a621: { // upload.saveFilePart
      console.log(`[${new Date().toISOString()}] Session ${session.id} upload.saveFilePart`);
      const reader = new BinaryReader(data);
      reader.offset = 4;
      const fileId = reader.readLong(false);
      const filePart = reader.readInt();
      const bytesLen = reader.readInt();
      const bytes = data.slice(reader.offset, reader.offset + bytesLen);
      messageStore.saveFilePart(fileId.toString(), filePart, bytes);
      return buildBoolTrue();
    }

    case 0xde7b673d: { // upload.saveBigFilePart
      console.log(`[${new Date().toISOString()}] Session ${session.id} upload.saveBigFilePart`);
      const reader = new BinaryReader(data);
      reader.offset = 4;
      const fileId = reader.readLong(false);
      const filePart = reader.readInt();
      reader.readInt(); // fileTotalParts
      const bytesLen = reader.readInt();
      const bytes = data.slice(reader.offset, reader.offset + bytesLen);
      messageStore.saveFilePart(fileId.toString(), filePart, bytes);
      return buildBoolTrue();
    }

    case 0xbe5335be: { // upload.getFile
      console.log(`[${new Date().toISOString()}] Session ${session.id} upload.getFile`);
      const reader = new BinaryReader(data);
      reader.offset = 4;
      reader.readInt(); // flags
      const locationConstructor = reader.readInt() >>> 0;
      let fileData: Buffer | undefined;
      let fileMimeType: string | undefined;
      let thumbSize = '';
      let lookupFileId = ''; // for data/files/ fallback
      if (locationConstructor === 0x37257e99) {
        // inputPeerPhotoFileLocation#37257e99 flags:# big:flags.0?true peer:InputPeer photo_id:long
        reader.readInt(); // photoFlags
        skipInputPeer(reader);
        const photoId = reader.readLong(false);
        const mediaId = Number(photoId & 0xFFFFFn); // reverse publicPhotoId mapping
        fileData = messageStore.getMediaFileData(mediaId);
        if (fileData) {
          const media = messageStore.getMedia(mediaId);
          fileMimeType = media?.mimeType;
        }
        if (!fileData) fileData = messageStore.getUploadedFile(photoId.toString());
        console.log(`[GETFILE] inputPeerPhotoFileLocation photoId=${photoId} → mediaId=${mediaId}`);
      } else if (locationConstructor === 0xbad07584) {
        // inputDocumentFileLocation id:long access_hash:long file_reference:bytes thumb_size:string
        const docId = reader.readLong(false);
        reader.readLong(false); // access_hash
        skipTlStringByReader(reader); // file_reference
        thumbSize = readTlString(reader); // thumb_size
        lookupFileId = docId.toString();
        const mediaId = Number(docId);
        fileData = messageStore.getMediaFileData(mediaId);
        if (fileData) {
          const media = messageStore.getMedia(mediaId);
          fileMimeType = media?.mimeType;
        }
        if (!fileData) fileData = messageStore.getUploadedFile(docId.toString());
        console.log(`[GETFILE] inputDocumentFileLocation id=${docId} thumbSize="${thumbSize}"`);
      } else if (locationConstructor === 0x40181ffe) {
        // inputPhotoFileLocation id:long access_hash:long file_reference:bytes thumb_size:string
        const photoId = reader.readLong(false);
        reader.readLong(false); // access_hash
        skipTlStringByReader(reader); // file_reference
        thumbSize = readTlString(reader); // thumb_size
        lookupFileId = photoId.toString();
        const mediaId = Number(photoId & 0xFFFFFn); // reverse publicPhotoId mapping
        fileData = messageStore.getMediaFileData(mediaId);
        if (fileData) {
          const media = messageStore.getMedia(mediaId);
          fileMimeType = media?.mimeType;
        }
        if (!fileData) fileData = messageStore.getUploadedFile(photoId.toString());
        console.log(`[GETFILE] inputPhotoFileLocation photoId=${photoId} → mediaId=${mediaId} thumbSize="${thumbSize}"`);
      } else {
        console.log(`[GETFILE] unknown location constructor 0x${locationConstructor.toString(16)}`);
      }
      // Read offset and limit — these come AFTER the location in upload.getFile
      const fileOffset = Number(reader.readLong(false));
      const fileLimit = reader.readInt();
      // Fallback: check data/files/ directory (e.g. reaction animations captured from official Telegram)
      if (!fileData && lookupFileId) {
        const cachedPath = _dataFilesDir + '/' + lookupFileId;
        if (_fsExists(cachedPath)) {
          fileData = _fsRead(cachedPath);
          console.log(`[GETFILE] loaded from data/files/${lookupFileId} (${fileData.length} bytes)`);
        }
      }
      if (!fileData) {
        console.log(`[GETFILE] file NOT FOUND`);
        const w = new BinaryWriter();
        w.writeInt(0x96a18d5); // upload.file
        w.writeInt(0xaa963b05); // storage.fileUnknown
        w.writeInt(0);
        writeTlBytes(w, Buffer.alloc(0));
        return w.getBytes();
      }
      // Serve the requested slice
      const slice = fileData.subarray(fileOffset, fileOffset + fileLimit);
      console.log(`[GETFILE] offset=${fileOffset} limit=${fileLimit} totalSize=${fileData.length} → serving ${slice.length} bytes (mime=${fileMimeType || 'unknown'} thumbSize="${thumbSize}")`);
      // Determine storage file type from MIME
      let storageFileType = 0x007efe0e; // storage.fileJpeg (default)
      if (fileMimeType) {
        if (fileMimeType.includes('png')) storageFileType = 0x0a4f63c0; // storage.filePng
        else if (fileMimeType.includes('gif')) storageFileType = 0xcae1aadf; // storage.fileGif
        else if (fileMimeType.includes('mp4') || fileMimeType.includes('video')) storageFileType = 0xb3cea0e4; // storage.fileMp4
        else if (fileMimeType.includes('webp')) storageFileType = 0x1081464c; // storage.fileWebp
        else if (fileMimeType.includes('pdf')) storageFileType = 0xae1e508d; // storage.filePdf
        else if (fileMimeType.includes('ogg') || fileMimeType.includes('audio') || fileMimeType.includes('opus')) storageFileType = 0xaa963b05; // storage.fileUnknown (no specific type for audio)
      }
      const w = new BinaryWriter();
      w.writeInt(0x96a18d5); // upload.file#096a18d5
      w.writeInt(storageFileType);
      w.writeInt(Math.floor(Date.now() / 1000));
      writeTlBytes(w, slice);
      return w.getBytes();
    }

    case 0x330e77f: { // messages.sendMedia
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.sendMedia`);
      const mediaReq = parseSendMediaRequest(data);
      if (!mediaReq?.peerKey) {
        console.log(`[WARN] sendMedia: parse failed or no peerKey`);
        return buildRpcErrorObject(400, 'MEDIA_INVALID');
      }
      console.log(`[MEDIA] parsed: type=${mediaReq.mediaType} peer=${mediaReq.peerKey} fileId=${mediaReq.fileId} msg="${mediaReq.message}" randomId=${mediaReq.randomId}`);

      const mediaPeerErr = validatePeerKey(mediaReq.peerKey);
      if (mediaPeerErr) return buildRpcErrorObject(400, mediaPeerErr);

      const mediaSelfId = session.userId || SEED_USER_ID;
      if (!messageLimiter.check(String(mediaSelfId))) {
        return buildRpcErrorObject(420, 'FLOOD_WAIT_60');
      }

      // Assemble uploaded file
      const fileData = messageStore.getUploadedFile(mediaReq.fileId);
      if (!fileData) {
        console.log(`[WARN] sendMedia: file not found for fileId=${mediaReq.fileId}`);
        return buildRpcErrorObject(400, 'FILE_PARTS_INVALID');
      }
      console.log(`[MEDIA] file assembled: ${fileData.length} bytes`);

      // Determine dimensions and audio attributes from document attributes if available
      let mediaWidth: number | undefined;
      let mediaHeight: number | undefined;
      let mediaFileName = mediaReq.fileName;
      let mediaDuration: number | undefined;
      let mediaWaveform: Buffer | undefined;
      let mediaIsVoice: boolean | undefined;
      if (mediaReq.docAttributes) {
        for (const attr of mediaReq.docAttributes) {
          if (attr.type === 'imageSize') { mediaWidth = attr.w; mediaHeight = attr.h; }
          if (attr.type === 'filename') { mediaFileName = attr.name; }
          if (attr.type === 'audio') {
            mediaDuration = attr.duration;
            mediaWaveform = attr.waveform;
            mediaIsVoice = attr.voice;
          }
        }
      }

      // For photos: extract real dimensions from image headers if not provided
      if (mediaReq.mediaType === 'photo' && !mediaWidth) {
        const dims = getImageDimensions(fileData);
        if (dims) {
          mediaWidth = dims.width;
          mediaHeight = dims.height;
          console.log(`[MEDIA] extracted dimensions: ${mediaWidth}x${mediaHeight}`);
        }
      }

      // Save media to disk + DB
      const savedMedia = messageStore.saveMedia({
        type: mediaReq.mediaType,
        fileData,
        mimeType: mediaReq.mimeType || (mediaReq.mediaType === 'photo' ? 'image/jpeg' : 'application/octet-stream'),
        width: mediaWidth,
        height: mediaHeight,
        fileName: mediaFileName,
        duration: mediaDuration,
        waveform: mediaWaveform,
        isVoice: mediaIsVoice,
      });
      console.log(`[MEDIA] saved: id=${savedMedia.id} path=${savedMedia.filePath}${mediaIsVoice ? ' (voice)' : ''}`);

      const mediaIsSavedMessages = mediaReq.peerKey === `user:${mediaSelfId}`;
      const mediaIsP2P = mediaReq.peerKey.startsWith('user:') && !mediaIsSavedMessages;
      const mediaIsGroupChat = mediaReq.peerKey.startsWith('chat:') || mediaReq.peerKey.startsWith('channel:');
      const mediaSenderPeerKey = mediaIsGroupChat ? `user:${mediaSelfId}` : (mediaReq.peerKey.startsWith('channel:')
        ? undefined
        : `user:${mediaSelfId}`);

      // Delete draft for this peer if exists
      messageStore.deleteDraft(mediaSelfId, mediaReq.peerKey);

      const storedMediaMsg = messageStore.appendOutgoingMessage(mediaSelfId, {
        peerKey: mediaReq.peerKey,
        text: mediaReq.message,
        clientRandomId: mediaReq.randomId,
        seedMaxMessageId: 0,
        fromPeerKey: mediaIsSavedMessages ? undefined : mediaSenderPeerKey,
        post: mediaReq.peerKey.startsWith('channel:') && !messageStore.getChatById(Number(mediaReq.peerKey.split(':')[1]))?.isMegagroup,
        replyToMsgId: mediaReq.replyToMsgId,
        quoteText: mediaReq.quoteText,
        quoteOffset: mediaReq.quoteOffset,
        mediaId: savedMedia.id,
      });
      console.log(`[MEDIA] message stored: msgId=${storedMediaMsg.messageId} mediaId=${storedMediaMsg.mediaId} pts=${storedMediaMsg.updatePts}`);

      const mediaMessageFixture = getStoredMessageAsFixture(mediaReq.peerKey, storedMediaMsg.messageId, mediaSelfId);

      const mediaUserIds: string[] = [String(mediaSelfId)];
      const mediaChatIds: string[] = [];
      if (mediaMessageFixture) {
        collectEntityIdsFromPeerKey(mediaMessageFixture.peerKey, mediaUserIds, mediaChatIds);
      }

      const mediaSharedUpdates: Buffer[] = [];
      if (mediaMessageFixture) {
        mediaSharedUpdates.push(buildUpdateNewMessage(mediaMessageFixture, storedMediaMsg.updatePts, storedMediaMsg.updatePtsCount));
      }

      ctx.broadcastSessionUpdates(session, buildLiveUpdatesEnvelope(mediaSharedUpdates, mediaUserIds, mediaChatIds));

      if (mediaIsP2P) {
        const mediaRecipientIdStr = mediaReq.peerKey.replace('user:', '');
        const mediaRecipientId = Number(mediaRecipientIdStr);
        const mediaRecipientPeerKey = `user:${mediaSelfId}`;

        let recipientMediaReplyToMsgId: number | undefined;
        if (mediaReq.replyToMsgId) {
          const [resolved] = messageStore.resolveRecipientMessageIds(
            mediaSelfId, mediaReq.peerKey, mediaRecipientId, mediaRecipientPeerKey, [mediaReq.replyToMsgId],
          );
          recipientMediaReplyToMsgId = resolved;
        }

        const recipientMediaMsg = messageStore.appendOutgoingMessage(mediaRecipientId, {
          peerKey: mediaRecipientPeerKey,
          text: mediaReq.message,
          clientRandomId: `recv_${mediaReq.randomId}`,
          seedMaxMessageId: 0,
          fromPeerKey: `user:${mediaSelfId}`,
          post: false,
          replyToMsgId: recipientMediaReplyToMsgId,
          quoteText: mediaReq.quoteText,
          quoteOffset: mediaReq.quoteOffset,
          mediaId: savedMedia.id, // Same media reference
        });
        messageStore.markMessageIncoming(mediaRecipientId, mediaRecipientPeerKey, recipientMediaMsg.messageId);

        const recipientMediaFixture = getStoredMessageAsFixture(mediaRecipientPeerKey, recipientMediaMsg.messageId, mediaRecipientId);
        if (recipientMediaFixture) {
          const recipientMediaUserIds = [String(mediaSelfId), mediaRecipientIdStr];
          const recipientMediaUpdates: Buffer[] = [
            buildUpdateNewMessage(recipientMediaFixture, recipientMediaMsg.updatePts, recipientMediaMsg.updatePtsCount),
          ];
          ctx.broadcastToUser(
            mediaRecipientId,
            buildLiveUpdatesEnvelope(recipientMediaUpdates, recipientMediaUserIds, []),
          );
        }
      }

      // Group/channel: broadcast to all other participants
      if (mediaIsGroupChat) {
        const mediaChatId = Number(mediaReq.peerKey.split(':')[1]);
        const mediaParticipants = messageStore.getChatParticipants(mediaChatId);
        for (const p of mediaParticipants) {
          if (p.userId === mediaSelfId) continue;
          const participantMediaMsg = messageStore.appendOutgoingMessage(p.userId, {
            peerKey: mediaReq.peerKey,
            text: mediaReq.message,
            clientRandomId: `group_${mediaReq.randomId}_${p.userId}`,
            seedMaxMessageId: 0,
            fromPeerKey: `user:${mediaSelfId}`,
            post: storedMediaMsg.post,
            replyToMsgId: mediaReq.replyToMsgId,
            quoteText: mediaReq.quoteText,
            quoteOffset: mediaReq.quoteOffset,
            mediaId: savedMedia.id,
          });
          messageStore.markMessageIncoming(p.userId, mediaReq.peerKey, participantMediaMsg.messageId);
          const pMediaFixture = getStoredMessageAsFixture(mediaReq.peerKey, participantMediaMsg.messageId, p.userId);
          if (pMediaFixture) {
            const pMediaUserIds = [String(mediaSelfId), String(p.userId)];
            ctx.broadcastToUser(
              p.userId,
              buildLiveUpdatesEnvelopeWithChats(
                [buildUpdateNewMessage(pMediaFixture, participantMediaMsg.updatePts, participantMediaMsg.updatePtsCount)],
                pMediaUserIds,
                [mediaChatId],
                p.userId,
              ),
            );
          }
        }
      }

      const mediaSenderUpdates: Buffer[] = [
        buildUpdateMessageID(storedMediaMsg.messageId, mediaReq.randomId),
        ...mediaSharedUpdates,
      ];
      return buildLiveUpdatesEnvelope(mediaSenderUpdates, mediaUserIds, mediaChatIds);
    }

    case 0x91cd32a8: { // photos.getUserPhotos
      console.log(`[${new Date().toISOString()}] Session ${session.id} photos.getUserPhotos`);
      const selfId = session.userId || SEED_USER_ID;
      const reader = new BinaryReader(data);
      reader.offset = 4; // skip constructor
      const userRef = readInputUserRef(reader, session);
      const targetUserId = userRef ? Number(userRef.userId) : selfId;
      const offset = reader.readInt();
      reader.readLong(); // max_id (ignored)
      const limit = reader.readInt();

      const targetUser = messageStore.getUserById(targetUserId);
      const w = new BinaryWriter();
      w.writeInt(0x8dca6aa5); // photos.photos
      w.writeInt(0x1cb5c415); // vector
      if (targetUser?.photoId && offset === 0 && limit > 0) {
        const media = messageStore.getMedia(targetUser.photoId);
        if (media) {
          w.writeInt(1);
          writePhotoObject(w, media);
        } else {
          w.writeInt(0);
        }
      } else {
        w.writeInt(0);
      }
      w.writeInt(0x1cb5c415); // users vector
      w.writeInt(0);
      return w.getBytes();
    }

    case 0x388a3b5: { // photos.uploadProfilePhoto
      console.log(`[${new Date().toISOString()}] Session ${session.id} photos.uploadProfilePhoto`);
      const selfId = session.userId || SEED_USER_ID;
      const request = parseUploadProfilePhotoRequest(data);
      const targetUserId = request?.targetUserId || selfId;
      if (!request?.fileId) {
        return buildRpcErrorObject(400, 'PHOTO_INVALID');
      }

      const fileData = messageStore.getUploadedFile(request.fileId);
      if (!fileData) {
        return buildRpcErrorObject(400, 'PHOTO_INVALID');
      }

      const savedMedia = messageStore.saveMedia({
        type: 'photo',
        fileData,
        mimeType: 'image/jpeg',
      });
      messageStore.updateUser(targetUserId, { photoId: savedMedia.id });

      const updatedUser = getFixtureUserForId(undefined, String(targetUserId), targetUserId === selfId);
      const w = new BinaryWriter();
      w.writeInt(0x20212ca8); // photos.photo
      writePhotoObject(w, savedMedia);
      w.writeInt(0x1cb5c415);
      w.writeInt(1);
      writeUserFromFixture(w, updatedUser);
      return w.getBytes();
    }

    case 0x78515775: { // account.updateProfile
      console.log(`[${new Date().toISOString()}] Session ${session.id} account.updateProfile`);
      const reader = new BinaryReader(data);
      reader.offset = 4;
      const profileFlags = reader.readInt();
      let newFirstName: string | undefined;
      let newLastName: string | undefined;
      let newAbout: string | undefined;
      if (profileFlags & (1 << 0)) newFirstName = readTlString(reader);
      if (profileFlags & (1 << 1)) newLastName = readTlString(reader);
      if (profileFlags & (1 << 2)) newAbout = readTlString(reader);

      if (newFirstName !== undefined) {
        const fnErr = validateName(newFirstName, 'FIRSTNAME');
        if (fnErr) return buildRpcErrorObject(400, fnErr);
      }
      if (newLastName !== undefined) {
        const lnErr = validateName(newLastName, 'LASTNAME');
        if (lnErr) return buildRpcErrorObject(400, lnErr);
      }

      const selfId = session.userId || SEED_USER_ID;
      if (newFirstName !== undefined || newLastName !== undefined || newAbout !== undefined) {
        messageStore.updateUser(selfId, { firstName: newFirstName, lastName: newLastName, about: newAbout ?? undefined });
      }

      const updatedUser = getFixtureUserForId(undefined, String(selfId), true);
      const w = new BinaryWriter();
      writeUserFromFixture(w, { ...updatedUser, self: true });
      return w.getBytes();
    }

    case 0xcc6e0c11: { // account.updateBirthday
      console.log(`[${new Date().toISOString()}] Session ${session.id} account.updateBirthday`);
      const reader = new BinaryReader(data);
      reader.offset = 4;
      const bdFlags = reader.readInt();
      const selfId = session.userId || SEED_USER_ID;
      if (bdFlags & (1 << 0)) {
        // birthday#6c8e1e06 flags:# day:int month:int year:flags.0?int
        const bdCtor = reader.readInt() >>> 0;
        const bdInnerFlags = reader.readInt();
        const day = reader.readInt();
        const month = reader.readInt();
        let year: number | null = null;
        if (bdInnerFlags & (1 << 0)) year = reader.readInt();
        messageStore.updateUser(selfId, { birthdayDay: day, birthdayMonth: month, birthdayYear: year });
      } else {
        // Clearing birthday
        messageStore.updateUser(selfId, { birthdayDay: null, birthdayMonth: null, birthdayYear: null });
      }
      return buildBoolTrue();
    }

    case 0x2714d86c: { // account.checkUsername
      console.log(`[${new Date().toISOString()}] Session ${session.id} account.checkUsername`);
      const reader = new BinaryReader(data);
      reader.offset = 4;
      const usernameToCheck = readTlString(reader);
      const validErr = validateUsername(usernameToCheck);
      if (validErr) return buildRpcErrorObject(400, validErr);
      const occupied = messageStore.getUserByUsername(usernameToCheck);
      // boolTrue#997275b5  boolFalse#bc799737
      const w = new BinaryWriter();
      w.writeInt(occupied ? 0xbc799737 : 0x997275b5);
      return w.getBytes();
    }

    case 0x3e0bdd7c: { // account.updateUsername
      console.log(`[${new Date().toISOString()}] Session ${session.id} account.updateUsername`);
      const selfId = session.userId || SEED_USER_ID;
      const reader = new BinaryReader(data);
      reader.offset = 4;
      const newUsername = readTlString(reader);
      // empty string means "remove username"
      if (newUsername !== '') {
        const validErr = validateUsername(newUsername);
        if (validErr) return buildRpcErrorObject(400, validErr);
        // check not occupied by someone else
        const existing = messageStore.getUserByUsername(newUsername);
        if (existing && existing.id !== selfId) {
          return buildRpcErrorObject(400, 'USERNAME_OCCUPIED');
        }
      }
      // Pass newUsername directly — updateUser handles '' → null in DB
      messageStore.updateUser(selfId, { username: newUsername });
      const updatedUser = getFixtureUserForId(undefined, String(selfId), true);
      // Push UpdateUserName to all connected sessions of this user
      const unUpdate = buildUpdateUserNameUpdate(
        selfId,
        updatedUser.firstName || '',
        updatedUser.lastName || '',
        newUsername || undefined,
      );
      ctx.broadcastToUser(selfId, buildLiveUpdatesEnvelope([unUpdate], [String(selfId)], []));
      const w = new BinaryWriter();
      writeUserFromFixture(w, { ...updatedUser, self: true });
      return w.getBytes();
    }

    case 0x13704a7c: { // messages.forwardMessages
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.forwardMessages`);
      const selfId = session.userId || SEED_USER_ID;
      const fwdReq = parseForwardMessagesRequest(data, session);
      if (!fwdReq || !fwdReq.toPeerKey) {
        return buildRpcErrorObject(400, 'PEER_ID_INVALID');
      }
      console.log(`[FWD-DEBUG] dropAuthor=${fwdReq.dropAuthor} dropMediaCaptions=${fwdReq.dropMediaCaptions} from=${fwdReq.fromPeerKey} to=${fwdReq.toPeerKey} msgIds=${fwdReq.messageIds}`);

      const allUpdates: Buffer[] = [];
      const userIds: string[] = [String(selfId)];
      const chatIds: string[] = [];
      collectEntityIdsFromPeerKey(fwdReq.toPeerKey, userIds, chatIds);

      for (let i = 0; i < fwdReq.messageIds.length; i++) {
        const origMsg = messageStore.getMessageForUser(fwdReq.messageIds[i], selfId);
        const text = origMsg?.text || '';

        // Determine fwd_from metadata
        let fwdFromPeerKey: string | undefined;
        let fwdFromName: string | undefined;
        const fwdDate = origMsg?.date || Math.floor(Date.now() / 1000);

        if (origMsg?.fwdFromPeerKey) {
          // Already a forwarded message — preserve original fwd_from
          fwdFromPeerKey = origMsg.fwdFromPeerKey;
          fwdFromName = origMsg.fwdFromName;
        } else if (origMsg?.fromPeerKey) {
          fwdFromPeerKey = origMsg.fromPeerKey;
        } else if (fwdReq.fromPeerKey) {
          fwdFromPeerKey = fwdReq.fromPeerKey;
        }

        // Build display name if we have a peer key for it
        if (fwdFromPeerKey && !fwdFromName) {
          const fwdUserId = fwdFromPeerKey.startsWith('user:') ? Number(fwdFromPeerKey.replace('user:', '')) : 0;
          if (fwdUserId) {
            const fwdUser = messageStore.getUserById(fwdUserId);
            if (fwdUser) {
              fwdFromName = fwdUser.firstName + (fwdUser.lastName ? ` ${fwdUser.lastName}` : '');
            }
          }
        }

        // drop_author: remove forward header entirely — message appears as written by the forwarder
        if (fwdReq.dropAuthor) {
          fwdFromPeerKey = undefined;
          fwdFromName = undefined;
        }
        console.log(`[FWD-DEBUG] final: fwdFromPeerKey=${fwdFromPeerKey} fwdFromName=${fwdFromName} dropAuthor=${fwdReq.dropAuthor}`);

        const stored = messageStore.appendOutgoingMessage(selfId, {
          peerKey: fwdReq.toPeerKey,
          text,
          clientRandomId: fwdReq.randomIds[i] || `fwd_${Date.now()}_${i}`,
          seedMaxMessageId: 0,
          fromPeerKey: `user:${selfId}`,
          post: false,
          fwdFromPeerKey,
          fwdFromName,
          fwdDate: fwdReq.dropAuthor ? undefined : fwdDate,
          mediaId: origMsg?.mediaId,
        });

        const fixture = getStoredMessageAsFixture(fwdReq.toPeerKey, stored.messageId, selfId);
        if (fixture) {
          // Must send updateMessageID first so client can map random_id → real message_id
          if (fwdReq.randomIds[i]) {
            allUpdates.push(buildUpdateMessageID(stored.messageId, fwdReq.randomIds[i]));
          }
          allUpdates.push(buildUpdateNewMessage(fixture, stored.updatePts, stored.updatePtsCount));
          // Add fwd_from user to entity list
          if (fwdFromPeerKey) collectEntityIdsFromPeerKey(fwdFromPeerKey, userIds, chatIds);
        }

        const isSavedMessages = fwdReq.toPeerKey === `user:${selfId}`;
        const isP2P = fwdReq.toPeerKey.startsWith('user:') && !isSavedMessages;
        if (isP2P) {
          const recipientId = Number(fwdReq.toPeerKey.replace('user:', ''));
          const recipientPeerKey = `user:${selfId}`;
          const recipientMsg = messageStore.appendOutgoingMessage(recipientId, {
            peerKey: recipientPeerKey,
            text,
            clientRandomId: `recv_fwd_${Date.now()}_${i}`,
            seedMaxMessageId: 0,
            fromPeerKey: `user:${selfId}`,
            post: false,
            fwdFromPeerKey,
            fwdFromName,
            fwdDate: fwdReq.dropAuthor ? undefined : fwdDate,
            mediaId: origMsg?.mediaId,
          });
          messageStore.markMessageIncoming(recipientId, recipientPeerKey, recipientMsg.messageId);
          const recipientFixture = getStoredMessageAsFixture(recipientPeerKey, recipientMsg.messageId, recipientId);
          if (recipientFixture) {
            ctx.broadcastToUser(recipientId, buildLiveUpdatesEnvelope(
              [buildUpdateNewMessage(recipientFixture, recipientMsg.updatePts, recipientMsg.updatePtsCount)],
              [String(selfId), String(recipientId)],
              [],
            ));
          }
        }

        // Group/channel forwarding: broadcast to all participants
        const isGroupFwd = fwdReq.toPeerKey.startsWith('chat:') || fwdReq.toPeerKey.startsWith('channel:');
        if (isGroupFwd) {
          const chatId = Number(fwdReq.toPeerKey.split(':')[1]);
          const participants = messageStore.getChatParticipants(chatId);
          for (const p of participants) {
            if (p.userId === selfId) continue;
            const pMsg = messageStore.appendOutgoingMessage(p.userId, {
              peerKey: fwdReq.toPeerKey,
              text,
              clientRandomId: `group_fwd_${Date.now()}_${i}_${p.userId}`,
              seedMaxMessageId: 0,
              fromPeerKey: `user:${selfId}`,
              post: false,
              fwdFromPeerKey,
              fwdFromName,
              fwdDate: fwdReq.dropAuthor ? undefined : fwdDate,
              mediaId: origMsg?.mediaId,
            });
            messageStore.markMessageIncoming(p.userId, fwdReq.toPeerKey, pMsg.messageId);
            const pFixture = getStoredMessageAsFixture(fwdReq.toPeerKey, pMsg.messageId, p.userId);
            if (pFixture) {
              ctx.broadcastToUser(p.userId, buildLiveUpdatesEnvelopeWithChats(
                [buildUpdateNewMessage(pFixture, pMsg.updatePts, pMsg.updatePtsCount)],
                [String(selfId), String(p.userId)],
                [chatId],
                p.userId,
              ));
            }
          }
        }
      }

      ctx.broadcastSessionUpdates(session, buildLiveUpdatesEnvelope(allUpdates, userIds, chatIds));
      return buildLiveUpdatesEnvelope(allUpdates, userIds, chatIds);
    }

    case 0xd30d78d4: { // messages.sendReaction
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.sendReaction`);
      const reactSelfId = session.userId || SEED_USER_ID;
      const reactReq = parseSendReactionRequest(data);
      console.log(`[REACT-DEBUG] parsed: peer=${reactReq?.peerKey} msgId=${reactReq?.msgId} reactions=${JSON.stringify(reactReq?.reactions)}`);
      if (reactReq?.peerKey && reactReq.msgId) {
        if (reactReq.reactions.length > 0) {
          messageStore.setReaction(reactSelfId, reactReq.peerKey, reactReq.msgId, reactSelfId, reactReq.reactions[0]);
          console.log(`[REACT-DEBUG] stored reaction: owner=${reactSelfId} peer=${reactReq.peerKey} msg=${reactReq.msgId} emoticon=${reactReq.reactions[0]}`);
        } else {
          messageStore.removeReaction(reactSelfId, reactReq.peerKey, reactReq.msgId, reactSelfId);
        }
        messageStore.appendReactionEvent(reactSelfId, reactReq.peerKey, reactReq.msgId);
        // Broadcast update to the other user (for P2P)
        if (reactReq.peerKey.startsWith('user:') && reactReq.peerKey !== `user:${reactSelfId}`) {
          const otherUserId = Number(reactReq.peerKey.replace('user:', ''));
          const otherPeerKey = `user:${reactSelfId}`;
          // Resolve the recipient's message ID (different from sender's)
          const [otherMsgId] = messageStore.resolveRecipientMessageIds(
            reactSelfId, reactReq.peerKey, otherUserId, otherPeerKey, [reactReq.msgId],
          );
          if (otherMsgId) {
            if (reactReq.reactions.length > 0) {
              messageStore.setReaction(otherUserId, otherPeerKey, otherMsgId, reactSelfId, reactReq.reactions[0]);
            } else {
              messageStore.removeReaction(otherUserId, otherPeerKey, otherMsgId, reactSelfId);
            }
            messageStore.appendReactionEvent(otherUserId, otherPeerKey, otherMsgId);
            // Broadcast reaction update to the other user's sessions
            const otherReactions = aggregateReactions(otherUserId, otherPeerKey, otherMsgId, otherUserId);
            const otherLive = buildLiveUpdateMessageReactions(otherPeerKey, otherMsgId, otherReactions);
            ctx.broadcastToUser(otherUserId, otherLive);
          }
        } else if (reactReq.peerKey.startsWith('chat:')) {
          // Group chats: store + broadcast to all participants
          const chatId = Number(reactReq.peerKey.split(':')[1]);
          const participants = messageStore.getChatParticipants(chatId);
          for (const p of participants) {
            if (p.userId === reactSelfId) continue;
            if (reactReq.reactions.length > 0) {
              messageStore.setReaction(p.userId, reactReq.peerKey, reactReq.msgId, reactSelfId, reactReq.reactions[0]);
            } else {
              messageStore.removeReaction(p.userId, reactReq.peerKey, reactReq.msgId, reactSelfId);
            }
            messageStore.appendReactionEvent(p.userId, reactReq.peerKey, reactReq.msgId);
            const pReactions = aggregateReactions(p.userId, reactReq.peerKey, reactReq.msgId, p.userId);
            ctx.broadcastToUser(p.userId, buildLiveUpdateMessageReactions(reactReq.peerKey, reactReq.msgId, pReactions));
          }
        }
        // Build reaction response for the sender
        const myReactions = aggregateReactions(reactSelfId, reactReq.peerKey, reactReq.msgId, reactSelfId);
        console.log(`[REACT-DEBUG] sender aggregated: ${JSON.stringify(myReactions)}`);
        return buildUpdateMessageReactions(reactReq.peerKey, reactReq.msgId, myReactions);
      }
      return buildUpdatesEmpty();
    }

    case 0x4bc6589a: { // messages.searchGlobal
      const sgSelfId = session.userId || SEED_USER_ID;
      const sgReq = parseSearchGlobalRequest(data);
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.searchGlobal (q="${sgReq?.query}", filter=${sgReq?.filterType}, users=${sgReq?.usersOnly}, groups=${sgReq?.groupsOnly}, broadcasts=${sgReq?.broadcastsOnly}, limit=${sgReq?.limit})`);
      if (sgReq && sgReq.query.trim()) {
        const hasMedia = sgReq.filterType === 'photos' || sgReq.filterType === 'video'
          || sgReq.filterType === 'photo_video' || sgReq.filterType === 'document'
          || sgReq.filterType === 'gif' || sgReq.filterType === 'music'
          || sgReq.filterType === 'voice';
        // Map context flags to peer prefix filter
        let peerPrefix: string | undefined;
        if (sgReq.usersOnly) peerPrefix = 'user:';
        else if (sgReq.groupsOnly) peerPrefix = 'group:';
        else if (sgReq.broadcastsOnly) peerPrefix = 'channel:';
        const results = messageStore.searchMessages(sgSelfId, sgReq.query, {
          offsetId: sgReq.offsetId,
          limit: Math.min(sgReq.limit || 20, 100),
          hasMedia: hasMedia || undefined,
          peerPrefix,
        });
        if (results.length > 0) {
          const fixtureMessages: FixtureMessage[] = results.map((msg) => ({
            id: msg.messageId,
            peerKey: msg.peerKey,
            date: msg.date,
            text: msg.text,
            className: msg.actionType ? 'MessageService' : 'Message',
            out: msg.isOutgoing,
            post: msg.post,
            fromPeerKey: msg.fromPeerKey,
            editDate: msg.editDate,
            replyToMsgId: msg.replyToMsgId,
            quoteText: msg.quoteText,
            quoteOffset: msg.quoteOffset,
            mediaId: msg.mediaId,
            fwdFromPeerKey: msg.fwdFromPeerKey,
            fwdFromName: msg.fwdFromName,
            fwdDate: msg.fwdDate,
            action: buildActionForFixture(msg.peerKey, msg.actionType, msg.text, msg.mediaId),
          }));
          return buildGetMessagesResponse(fixtureMessages, null, sgSelfId);
        }
      }
      return buildMessagesEmpty();
    }

    case 0x22567115: { // channels.checkSearchPostsFlood
      console.log(`[${new Date().toISOString()}] Session ${session.id} channels.checkSearchPostsFlood`);
      return buildSearchPostsFlood();
    }

    case 0xb6c8c393: { // contacts.getSponsoredPeers
      console.log(`[${new Date().toISOString()}] Session ${session.id} contacts.getSponsoredPeers`);
      return buildSponsoredPeersEmpty();
    }

    case 0x92ceddd4: { // messages.createChat
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.createChat`);
      const selfId = session.userId || SEED_USER_ID;
      const req = parseCreateChatRequest(data);
      if (!req || !req.title) {
        return buildRpcErrorObject(400, 'CHAT_TITLE_EMPTY');
      }

      const chat = messageStore.createChat({
        type: 'group',
        title: req.title,
        creatorUserId: selfId,
      });

      // Add invited users as participants
      for (const uid of req.userIds) {
        const resolvedUid = uid === -1 ? selfId : uid;
        if (resolvedUid === selfId || resolvedUid === 0) continue;
        messageStore.addChatParticipant(chat.id, resolvedUid, 'member', selfId);
      }

      // Re-fetch participants after additions
      const allParticipants = messageStore.getChatParticipants(chat.id);
      const updatedChat = messageStore.getChatById(chat.id) || chat;

      const chatPeerKey = `chat:${chat.id}`;
      const svcRandomId = BigInt('0x' + randomBytes(8).toString('hex')).toString();

      // Create service message (messageActionChatCreate) for the creator
      const svcMsg = messageStore.appendOutgoingMessage(selfId, {
        peerKey: chatPeerKey,
        text: req.title,
        clientRandomId: `svc_create_${chat.id}`,
        seedMaxMessageId: 0,
        fromPeerKey: `user:${selfId}`,
        actionType: 'chat_create',
      });

      // Build FixtureMessage for the service message
      const svcFixture = getStoredMessageAsFixture(chatPeerKey, svcMsg.messageId, selfId);
      if (!svcFixture) {
        return buildRpcErrorObject(500, 'INTERNAL_ERROR');
      }

      // Create service message for each invited participant so the chat appears in their dialogs
      for (const p of allParticipants) {
        if (p.userId === selfId) continue;
        const participantSvc = messageStore.appendOutgoingMessage(p.userId, {
          peerKey: chatPeerKey,
          text: req.title,
          clientRandomId: `recv_svc_create_${chat.id}`,
          seedMaxMessageId: 0,
          fromPeerKey: `user:${selfId}`,
          actionType: 'chat_create',
        });
        messageStore.markMessageIncoming(p.userId, chatPeerKey, participantSvc.messageId);

        // Broadcast update to participant
        const pFixture = getStoredMessageAsFixture(chatPeerKey, participantSvc.messageId, p.userId);
        if (pFixture) {
          const pUserIds = [String(selfId), String(p.userId)];
          const pChatIds = [String(chat.id)];
          ctx.broadcastToUser(p.userId, buildLiveUpdatesEnvelopeWithChats(
            [buildUpdateNewMessage(pFixture, participantSvc.updatePts, participantSvc.updatePtsCount)],
            pUserIds,
            [chat.id],
            selfId,
          ));
        }
      }

      // Broadcast the new chat update to the creator's other sessions too
      if (svcFixture) {
        const creatorUserIds = [String(selfId)];
        for (const p of allParticipants) {
          if (p.userId !== selfId) creatorUserIds.push(String(p.userId));
        }
        ctx.broadcastSessionUpdates(session, buildLiveUpdatesEnvelopeWithChats(
          [buildUpdateNewMessage(svcFixture, svcMsg.updatePts, svcMsg.updatePtsCount)],
          creatorUserIds,
          [chat.id],
          selfId,
        ));
      }

      return buildInvitedUsers(updatedChat, allParticipants, selfId, svcFixture, svcMsg.updatePts, svcMsg.updatePtsCount, svcRandomId);
    }

    case 0x91006707: { // channels.createChannel
      console.log(`[${new Date().toISOString()}] Session ${session.id} channels.createChannel`);
      const selfId = session.userId || SEED_USER_ID;
      const req = parseCreateChannelRequest(data);
      if (!req || !req.title) {
        return buildRpcErrorObject(400, 'CHAT_TITLE_EMPTY');
      }

      const chatType = req.isBroadcast ? 'channel' : 'supergroup';
      const chat = messageStore.createChat({
        type: chatType,
        title: req.title,
        about: req.about,
        creatorUserId: selfId,
        isBroadcast: req.isBroadcast,
        isMegagroup: req.isMegagroup,
      });

      const chanPeerKey = `channel:${chat.id}`;
      const chanRandomId = BigInt('0x' + randomBytes(8).toString('hex')).toString();

      // Create service message (messageActionChannelCreate) for the creator
      const chanSvcMsg = messageStore.appendOutgoingMessage(selfId, {
        peerKey: chanPeerKey,
        text: req.title,
        clientRandomId: `svc_create_chan_${chat.id}`,
        seedMaxMessageId: 0,
        fromPeerKey: `user:${selfId}`,
        actionType: 'channel_create',
        post: req.isBroadcast,
      });

      const chanSvcFixture = getStoredMessageAsFixture(chanPeerKey, chanSvcMsg.messageId, selfId);
      if (!chanSvcFixture) {
        return buildRpcErrorObject(500, 'INTERNAL_ERROR');
      }

      return buildCreateChannelUpdates(chat, selfId, chanSvcFixture, chanSvcMsg.updatePts, chanSvcMsg.updatePtsCount, chanRandomId);
    }

    case 0xaeb00b34: { // messages.getFullChat
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getFullChat`);
      const selfId = session.userId || SEED_USER_ID;
      const req = parseGetFullChatRequest(data);
      if (!req) {
        return buildRpcErrorObject(400, 'CHAT_ID_INVALID');
      }

      const chat = messageStore.getChatById(req.chatId);
      if (!chat) {
        return buildRpcErrorObject(400, 'CHAT_ID_INVALID');
      }

      const participants = messageStore.getChatParticipants(chat.id);
      return buildChatFull(chat, participants, selfId);
    }

    case 0x77ced9d0: { // channels.getParticipants
      console.log(`[${new Date().toISOString()}] Session ${session.id} channels.getParticipants`);
      const selfId = session.userId || SEED_USER_ID;
      const req = parseGetParticipantsRequest(data);
      if (!req || !req.channelId) {
        return buildRpcErrorObject(400, 'CHANNEL_INVALID');
      }

      const participants = messageStore.getChatParticipants(req.channelId);
      const sliced = participants.slice(req.offset, req.offset + req.limit);
      return buildChannelParticipants(sliced, selfId);
    }

    case 0xa0ab6cc6: { // channels.getParticipant (singular)
      console.log(`[${new Date().toISOString()}] Session ${session.id} channels.getParticipant`);
      const selfId = session.userId || SEED_USER_ID;
      const req = parseGetParticipantRequest(data);
      if (!req || !req.channelId) {
        return buildRpcErrorObject(400, 'CHANNEL_INVALID');
      }

      // Resolve participant user ID from peer key
      let participantUserId = selfId;
      if (req.participantPeerKey) {
        if (req.participantPeerKey.startsWith('user:')) {
          participantUserId = Number(req.participantPeerKey.replace('user:', ''));
        }
      }

      const chat = messageStore.getChatById(req.channelId);
      if (!chat) {
        return buildRpcErrorObject(400, 'CHANNEL_INVALID');
      }

      let participant = messageStore.getChatParticipant(req.channelId, participantUserId);
      if (!participant) {
        // If user is not a participant, return as a regular member (common for channel creator viewing self)
        participant = {
          chatId: req.channelId,
          userId: participantUserId,
          role: participantUserId === chat.creatorUserId ? 'creator' : 'member',
          date: chat.date,
        };
      }

      return buildChannelParticipantSingle(participant, chat, selfId);
    }

    case 0xc9e33d54: { // channels.inviteToChannel
      console.log(`[${new Date().toISOString()}] Session ${session.id} channels.inviteToChannel`);
      const selfId = session.userId || SEED_USER_ID;
      const req = parseInviteToChannelRequest(data);
      if (!req || !req.channelId) {
        return buildRpcErrorObject(400, 'CHANNEL_INVALID');
      }

      const chat = messageStore.getChatById(req.channelId);
      if (!chat) {
        return buildRpcErrorObject(400, 'CHANNEL_INVALID');
      }

      for (const uid of req.userIds) {
        const resolvedUid = uid === -1 ? selfId : uid;
        if (resolvedUid === 0) continue;
        messageStore.addChatParticipant(req.channelId, resolvedUid, 'member', selfId);
      }

      const allParticipants = messageStore.getChatParticipants(req.channelId);
      const updatedChat = messageStore.getChatById(req.channelId) || chat;
      return buildInvitedUsers(updatedChat, allParticipants, selfId);
    }

    case 0xf12e57c9: { // channels.editPhoto
      console.log(`[${new Date().toISOString()}] Session ${session.id} channels.editPhoto`);
      const selfId = session.userId || SEED_USER_ID;
      const req = parseEditPhotoRequest(data);
      if (!req || !req.channelId) {
        return buildRpcErrorObject(400, 'CHANNEL_INVALID');
      }

      const chat = messageStore.getChatById(req.channelId);
      if (!chat) {
        return buildRpcErrorObject(400, 'CHANNEL_INVALID');
      }

      // Save uploaded photo if present
      if (req.fileId) {
        const fileData = messageStore.getUploadedFile(req.fileId);
        if (fileData) {
          const savedMedia = messageStore.saveMedia({
            type: 'photo',
            fileData,
            mimeType: 'image/jpeg',
          });
          messageStore.updateChat(req.channelId, { photoId: savedMedia.id });
          // Refresh chat with updated photo
          const updatedChat = messageStore.getChatById(req.channelId) || chat;
          return buildCreateChannelUpdates(updatedChat, selfId);
        }
      }

      return buildCreateChannelUpdates(chat, selfId);
    }

    case 0x35ddd674: { // messages.editChatPhoto
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.editChatPhoto`);
      const selfId = session.userId || SEED_USER_ID;
      const req = parseEditChatPhotoRequest(data);
      if (!req || !req.chatId) {
        return buildRpcErrorObject(400, 'CHAT_ID_INVALID');
      }

      const chat = messageStore.getChatById(req.chatId);
      if (!chat) {
        return buildRpcErrorObject(400, 'CHAT_ID_INVALID');
      }

      let photoId: number | undefined;
      if (req.fileId) {
        const fileData = messageStore.getUploadedFile(req.fileId);
        if (fileData) {
          const savedMedia = messageStore.saveMedia({
            type: 'photo',
            fileData,
            mimeType: 'image/jpeg',
          });
          messageStore.updateChat(req.chatId, { photoId: savedMedia.id });
          photoId = savedMedia.id;
        }
      }

      // Create service message for the photo change
      const peerKey = `chat:${req.chatId}`;
      const svcResult = messageStore.appendOutgoingMessage(selfId, {
        peerKey,
        text: '',
        clientRandomId: `svc_edit_photo_${req.chatId}_${Date.now()}`,
        seedMaxMessageId: 0,
        fromPeerKey: `user:${selfId}`,
        actionType: 'chat_edit_photo',
        mediaId: photoId,
      });

      const svcMsg: FixtureMessage = {
        id: svcResult.messageId,
        peerKey,
        date: svcResult.date,
        text: '',
        className: 'MessageService',
        fromPeerKey: `user:${selfId}`,
        action: { type: 'chatEditPhoto', title: '', photoId },
      };

      const svcUpdate = buildUpdateNewMessage(svcMsg, svcResult.updatePts, svcResult.updatePtsCount);
      const updatedChat = messageStore.getChatById(req.chatId) || chat;

      // Broadcast to all chat participants
      const participants = messageStore.getChatParticipants(req.chatId);
      for (const p of participants) {
        if (p.userId === selfId) continue;
        const pSvcResult = messageStore.appendOutgoingMessage(p.userId, {
          peerKey,
          text: '',
          clientRandomId: `recv_svc_edit_photo_${req.chatId}_${Date.now()}`,
          seedMaxMessageId: 0,
          fromPeerKey: `user:${selfId}`,
          actionType: 'chat_edit_photo',
          mediaId: photoId,
        });
        messageStore.markMessageIncoming(p.userId, peerKey, pSvcResult.messageId);
        const pSvcMsg: FixtureMessage = {
          id: pSvcResult.messageId,
          peerKey,
          date: pSvcResult.date,
          text: '',
          className: 'MessageService',
          fromPeerKey: `user:${selfId}`,
          action: { type: 'chatEditPhoto', title: '', photoId },
        };
        const pUpdate = buildUpdateNewMessage(pSvcMsg, pSvcResult.updatePts, pSvcResult.updatePtsCount);
        ctx.broadcastToUser(p.userId, buildLiveUpdatesEnvelopeWithChats(
          [pUpdate], [String(selfId)], [req.chatId], selfId,
        ));
      }

      return buildLiveUpdatesEnvelopeWithChats(
        [svcUpdate], [String(selfId)], [req.chatId], selfId,
      );
    }

    case 0xa2b5a3f6: { // messages.getExportedChatInvites
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getExportedChatInvites`);
      // Return empty invites list
      // messages.exportedChatInvites#bdc62dcc count:int invites:Vector<ExportedChatInvite> users:Vector<User>
      const w = new BinaryWriter();
      w.writeInt(0xbdc62dcc);
      w.writeInt(0); // count
      w.writeInt(0x1cb5c415); w.writeInt(0); // empty vector invites
      w.writeInt(0x1cb5c415); w.writeInt(0); // empty vector users
      return w.getBytes();
    }

    case 0xdf04dd4e: { // messages.getChatInviteImporters
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getChatInviteImporters`);
      // messages.chatInviteImporters#81b6b00a count:int importers:Vector<ChatInviteImporter> users:Vector<User>
      const w = new BinaryWriter();
      w.writeInt(0x81b6b00a);
      w.writeInt(0); // count
      w.writeInt(0x1cb5c415); w.writeInt(0); // empty vector importers
      w.writeInt(0x1cb5c415); w.writeInt(0); // empty vector users
      return w.getBytes();
    }

    case 0x5bd0ee50: { // messages.deleteChat
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.deleteChat`);
      const selfId = session.userId || SEED_USER_ID;
      const reader = new BinaryReader(data);
      reader.offset = 4;
      const chatId = Number(reader.readLong(false));
      const peerKey = `chat:${chatId}`;

      // Get participants before deleting so we can notify them
      const participants = messageStore.getChatParticipants(chatId);

      // Create per-user service messages before deleting the chat so clients drop it immediately.
      const deletionUpdates = new Map<number, Buffer>();
      for (const p of participants) {
        const svc = messageStore.appendOutgoingMessage(p.userId, {
          peerKey,
          text: String(p.userId),
          clientRandomId: `svc_delete_chat_${chatId}_${p.userId}_${Date.now()}`,
          seedMaxMessageId: 0,
          fromPeerKey: `user:${selfId}`,
          actionType: 'chat_delete_user',
        });
        if (p.userId !== selfId) {
          messageStore.markMessageIncoming(p.userId, peerKey, svc.messageId);
        }
        const fixture: FixtureMessage = {
          id: svc.messageId,
          peerKey,
          date: svc.date,
          text: String(p.userId),
          className: 'MessageService',
          fromPeerKey: `user:${selfId}`,
          action: { type: 'chatDeleteUser', title: '', userId: p.userId },
        };
        const update = buildUpdateNewMessage(fixture, svc.updatePts, svc.updatePtsCount);
        // For each participant's notification, include themselves (self=true) so the client
        // recognises that THEY were removed and drops the chat from the dialog list in real-time.
        deletionUpdates.set(p.userId, buildLiveUpdatesEnvelopeWithChats(
          [update], [String(selfId)], [chatId], selfId, p.userId,
        ));
      }

      messageStore.deleteChat(chatId, peerKey);

      // Notify all participants with a delete-user service message. This is what the web client
      // translates into a local leave/removal state for basic groups.
      ctx.broadcastSessionUpdates(session, deletionUpdates.get(selfId) || null);
      for (const p of participants) {
        if (p.userId === selfId) continue;
        ctx.broadcastToUser(p.userId, deletionUpdates.get(p.userId) || null);
      }

      return buildBoolTrue();
    }

    case 0xc0111fe3: { // channels.deleteChannel
      console.log(`[${new Date().toISOString()}] Session ${session.id} channels.deleteChannel`);
      const selfId = session.userId || SEED_USER_ID;
      const reader = new BinaryReader(data);
      reader.offset = 4;
      const channelCid = reader.readInt() >>> 0;
      let channelId = 0;
      if (channelCid === 0xf35aec28) {
        channelId = Number(reader.readLong(false));
        reader.readLong(false); // access_hash
      }
      if (!channelId) return buildRpcErrorObject(400, 'CHANNEL_INVALID');

      const chat = messageStore.getChatById(channelId);
      if (!chat) return buildRpcErrorObject(400, 'CHANNEL_INVALID');

      // Get participants before deleting
      const participants = messageStore.getChatParticipants(channelId);

      const peerKey = `channel:${channelId}`;
      messageStore.deleteChat(channelId, peerKey);

      // Broadcast updateChannel#635b4c09 to all sessions
      const updateBuf = new BinaryWriter();
      updateBuf.writeInt(0x635b4c09); // updateChannel
      updateBuf.writeLong(BigInt(channelId));

      const envelope = buildLiveUpdatesEnvelope([updateBuf.getBytes()], [String(selfId)], []);
      ctx.broadcastSessionUpdates(session, envelope);

      for (const p of participants) {
        if (p.userId === selfId) continue;
        ctx.broadcastToUser(p.userId, envelope);
      }

      return envelope;
    }

    case 0x31c1c44f: { // messages.getMessageReadParticipants
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getMessageReadParticipants`);
      const rpSelfId = session.userId || SEED_USER_ID;
      // Parse: peer:InputPeer, msg_id:int
      const rpReader = new BinaryReader(data.subarray(4));
      const rpPeerKey = readInputPeerKey(rpReader);
      const rpMsgId = rpReader.readInt();
      const w = new BinaryWriter();
      // Vector<ReadParticipantDate>
      w.writeInt(0x1cb5c415);
      if (rpPeerKey?.startsWith('user:')) {
        const otherUserId = Number(rpPeerKey.replace('user:', ''));
        const otherPeerKey = `user:${rpSelfId}`;
        const peerState = messageStore.getPeerState(otherUserId, otherPeerKey);
        if (peerState && peerState.readInboxMaxId >= rpMsgId) {
          w.writeInt(1);
          // readParticipantDate#4a4ff172 user_id:long date:int
          w.writeInt(0x4a4ff172);
          w.writeLong(BigInt(otherUserId));
          w.writeInt(peerState.readInboxTs > 0 ? peerState.readInboxTs : Math.floor(Date.now() / 1000));
        } else {
          w.writeInt(0);
        }
      } else if (rpPeerKey?.startsWith('chat:')) {
        const chatId = Number(rpPeerKey.split(':')[1]);
        const participants = messageStore.getChatParticipants(chatId);
        const readerStates: { uid: number; ts: number }[] = [];
        for (const p of participants) {
          if (p.userId === rpSelfId) continue;
          const peerState = messageStore.getPeerState(p.userId, rpPeerKey);
          if (peerState && peerState.readInboxMaxId >= rpMsgId) {
            readerStates.push({ uid: p.userId, ts: peerState.readInboxTs > 0 ? peerState.readInboxTs : Math.floor(Date.now() / 1000) });
          }
        }
        w.writeInt(readerStates.length);
        for (const { uid, ts } of readerStates) {
          w.writeInt(0x4a4ff172);
          w.writeLong(BigInt(uid));
          w.writeInt(ts);
        }
      } else {
        w.writeInt(0);
      }
      return w.getBytes();
    }

    case 0x8c4bfe5d: { // messages.getOutboxReadDate
      console.log(`[${new Date().toISOString()}] Session ${session.id} messages.getOutboxReadDate`);
      const ordSelfId = session.userId || SEED_USER_ID;
      const ordReader = new BinaryReader(data.subarray(4));
      const ordPeerKey = readInputPeerKey(ordReader);
      const ordMsgId = ordReader.readInt();
      // Look up when the recipient first read past this message
      let ordDate = Math.floor(Date.now() / 1000);
      if (ordPeerKey?.startsWith('user:')) {
        const otherUserId = Number(ordPeerKey.replace('user:', ''));
        const otherPeerKey = `user:${ordSelfId}`;
        const peerState = messageStore.getPeerState(otherUserId, otherPeerKey);
        if (peerState && peerState.readInboxMaxId >= ordMsgId && peerState.readInboxTs > 0) {
          ordDate = peerState.readInboxTs;
        }
      }
      // outboxReadDate#3bb842ac date:int
      const w = new BinaryWriter();
      w.writeInt(0x3bb842ac);
      w.writeInt(ordDate);
      return w.getBytes();
    }

    // ===== messages.getDhConfig#26cf8950 version:int random_length:int =====
    case 0x26cf8950: {
      const r = new BinaryReader(data.slice(4));
      /* version = */ r.readInt();
      const randomLength = r.readInt();
      // messages.DhConfig#2c221edd g:int p:bytes version:int random:bytes
      const w = new BinaryWriter();
      w.writeInt(0x2c221edd);
      w.writeInt(3); // g
      writeTlBytes(w, _TG_DH_PRIME);
      w.writeInt(1); // version
      writeTlBytes(w, randomBytes(randomLength > 0 && randomLength <= 256 ? randomLength : 32));
      return w.getBytes();
    }

    // ===== phone.getCallConfig#55451fa9 =====
    case 0x55451fa9: {
      // DataJSON#7d748d04 data:string
      const w = new BinaryWriter();
      w.writeInt(0x7d748d04);
      writeTlString(w, '{}');
      return w.getBytes();
    }

    // ===== phone.requestCall#42ff96ed =====
    // flags:# video:flags.0?true user_id:InputUser random_id:int g_a_hash:bytes protocol:PhoneCallProtocol
    case 0x42ff96ed: {
      const myUserId = session.userId;
      if (!myUserId) return buildRpcErrorObject(401, 'AUTH_KEY_UNREGISTERED');
      const r = new BinaryReader(data.slice(4));
      const flags = r.readInt() >>> 0;
      const video = !!(flags & 1);
      // InputUser#f21158c6 user_id:long access_hash:long
      const inputUserCid = r.readInt() >>> 0;
      if (inputUserCid !== 0xf21158c6) return buildRpcErrorObject(400, 'BAD_REQUEST');
      const targetUserIdLong = r.readLong(false);
      r.readLong(false); // access_hash (not validated here)
      /* random_id */ r.readInt();
      const gaHash = Buffer.from(readTlBytesRaw(r));
      // skip protocol
      // protocol constructor + remaining bytes not needed - just ignore

      const targetUserId = Number(targetUserIdLong);
      const callId = BigInt('0x' + randomBytes(8).toString('hex'));
      const adminHash = BigInt('0x' + randomBytes(8).toString('hex').slice(0, 14));
      const participantHash = BigInt('0x' + randomBytes(8).toString('hex').slice(0, 14));
      const now = Math.floor(Date.now() / 1000);

      const call: CallRecord = {
        id: callId,
        adminId: myUserId,
        participantId: targetUserId,
        adminAccessHash: adminHash,
        participantAccessHash: participantHash,
        date: now,
        receiveDate: 0,
        startDate: 0,
        state: 'waiting',
        video,
        gaHash,
        gb: Buffer.alloc(0),
        ga: Buffer.alloc(0),
        keyFingerprint: BigInt(0),
      };
      _callsMap.set(_callKey(callId), call);

      // Push UpdatePhoneCall{PhoneCallRequested} to callee
      const requestedBuf = _buildPhoneCallRequested(call, participantHash);
      const updateBuf = _buildUpdatePhoneCall(requestedBuf);
      const envelope = buildLiveUpdatesEnvelope([updateBuf], [String(myUserId), String(targetUserId)], []);
      ctx.broadcastToUser(targetUserId, envelope, session.id);

      // Return phone.PhoneCall{PhoneCallWaiting} to caller
      const waitingBuf = _buildPhoneCallWaiting(call, adminHash, false);
      return _buildPhoneCallContainer(waitingBuf);
    }

    // ===== phone.receivedCall#17d54f61 peer:InputPhoneCall =====
    case 0x17d54f61: {
      const myUserId = session.userId;
      if (!myUserId) return buildRpcErrorObject(401, 'AUTH_KEY_UNREGISTERED');
      const r = new BinaryReader(data.slice(4));
      const { id: callId } = _readInputPhoneCall(r);
      const call = _callsMap.get(_callKey(callId));
      if (!call) return buildBoolTrue();

      // Only notify caller about receiveDate while still in 'waiting' state.
      // If accepted/active already, ignore — broadcasting PhoneCallWaiting at that
      // point would revert the caller's state back to waiting.
      if (call.state === 'waiting') {
        call.receiveDate = Math.floor(Date.now() / 1000);
        const waitingBuf = _buildPhoneCallWaiting(call, call.adminAccessHash, true);
        const updateBuf = _buildUpdatePhoneCall(waitingBuf);
        const envelope = buildLiveUpdatesEnvelope([updateBuf], [String(call.adminId), String(call.participantId)], []);
        ctx.broadcastToUser(call.adminId, envelope, session.id);
      }

      return buildBoolTrue();
    }

    // ===== phone.acceptCall#3bd2b4a0 peer:InputPhoneCall g_b:bytes protocol:PhoneCallProtocol =====
    case 0x3bd2b4a0: {
      const myUserId = session.userId;
      if (!myUserId) return buildRpcErrorObject(401, 'AUTH_KEY_UNREGISTERED');
      const r = new BinaryReader(data.slice(4));
      const { id: callId } = _readInputPhoneCall(r);
      const gb = Buffer.from(readTlBytesRaw(r));
      // skip protocol

      const call = _callsMap.get(_callKey(callId));
      if (!call) return buildRpcErrorObject(400, 'CALL_ALREADY_DECLINED');
      call.gb = gb;
      call.state = 'accepted';

      // Push UpdatePhoneCall{PhoneCallAccepted} to admin (caller)
      const acceptedBuf = _buildPhoneCallAccepted(call, call.adminAccessHash);
      const updateBuf = _buildUpdatePhoneCall(acceptedBuf);
      const envelope = buildLiveUpdatesEnvelope([updateBuf], [String(call.adminId), String(call.participantId)], []);
      ctx.broadcastToUser(call.adminId, envelope, session.id);

      // Return phone.PhoneCall{PhoneCallWaiting flags=1} to callee (acceptCall returns Waiting per spec)
      const waitingBuf = _buildPhoneCallWaiting(call, call.participantAccessHash, true);
      return _buildPhoneCallContainer(waitingBuf);
    }

    // ===== phone.confirmCall#2efe1722 peer:InputPhoneCall g_a:bytes key_fingerprint:long protocol:PhoneCallProtocol =====
    case 0x2efe1722: {
      const myUserId = session.userId;
      if (!myUserId) return buildRpcErrorObject(401, 'AUTH_KEY_UNREGISTERED');
      const r = new BinaryReader(data.slice(4));
      const { id: callId } = _readInputPhoneCall(r);
      const ga = Buffer.from(readTlBytesRaw(r));
      const keyFingerprint = r.readLong(true);
      // skip protocol

      const call = _callsMap.get(_callKey(callId));
      if (!call) return buildRpcErrorObject(400, 'CALL_ALREADY_DECLINED');
      call.ga = ga;
      call.keyFingerprint = keyFingerprint;
      call.startDate = Math.floor(Date.now() / 1000);
      call.state = 'active';

      // Push UpdatePhoneCall{PhoneCall active, gAOrB=gA} to callee
      const activeBufCallee = _buildPhoneCallActive(call, call.participantAccessHash, ga);
      const updateCallee = _buildUpdatePhoneCall(activeBufCallee);
      const envelopeCallee = buildLiveUpdatesEnvelope([updateCallee], [String(call.adminId), String(call.participantId)], []);
      ctx.broadcastToUser(call.participantId, envelopeCallee, session.id);

      // Return phone.PhoneCall{PhoneCall active, gAOrB=gB} to caller
      const activeBufCaller = _buildPhoneCallActive(call, call.adminAccessHash, call.gb);
      return _buildPhoneCallContainer(activeBufCaller);
    }

    // ===== phone.discardCall#b2cbc1c0 =====
    // flags:# video:flags.6?true peer:InputPhoneCall duration:int reason:PhoneCallDiscardReason connection_id:long
    case 0xb2cbc1c0: {
      const myUserId = session.userId;
      if (!myUserId) return buildRpcErrorObject(401, 'AUTH_KEY_UNREGISTERED');
      const r = new BinaryReader(data.slice(4));
      const flags = r.readInt();
      const { id: callId } = _readInputPhoneCall(r);
      const duration = r.readInt(); // call duration in seconds
      const reasonConstructorRaw = r.readInt() >>> 0; // PhoneCallDiscardReason constructor (unsigned)

      // Map reason constructor to string
      let reason = 'hangup';
      if (reasonConstructorRaw === 0x85e42301) reason = 'missed';
      else if (reasonConstructorRaw === 0xe095c1a0) reason = 'disconnect';
      else if (reasonConstructorRaw === 0xfabdef90) reason = 'busy';

      const isVideo = Boolean(flags & (1 << 6));

      const call = _callsMap.get(_callKey(callId));
      if (!call) {
        // Already gone — return empty updates
        return buildUpdatesEmpty();
      }
      call.state = 'discarded';
      _callsMap.delete(_callKey(callId));

      const discardedBuf = _buildPhoneCallDiscarded(callId);
      const updateBuf = _buildUpdatePhoneCall(discardedBuf);

      // Notify the other party
      const otherId = myUserId === call.adminId ? call.participantId : call.adminId;
      const updateEnvelope = buildLiveUpdatesEnvelope([updateBuf], [String(call.adminId), String(call.participantId)], []);
      ctx.broadcastToUser(otherId, updateEnvelope, session.id);

      // ---- Store call history message for both users ----
      const callMeta = JSON.stringify({ callId: callId.toString(), duration, reason, video: isVideo });

      // Caller (adminId) sees it as outgoing in their chat with participant
      const callerPeerKey = `user:${call.participantId}`;
      const callerMsg = messageStore.appendOutgoingMessage(call.adminId, {
        peerKey: callerPeerKey,
        text: callMeta,
        clientRandomId: `call_hist_admin_${callId.toString()}`,
        seedMaxMessageId: 0,
        fromPeerKey: `user:${call.adminId}`,
        actionType: 'phone_call',
      });
      const callerFixture = getStoredMessageAsFixture(callerPeerKey, callerMsg.messageId, call.adminId);
      if (callerFixture) {
        ctx.broadcastToUser(call.adminId, buildLiveUpdatesEnvelope(
          [buildUpdateNewMessage(callerFixture, callerMsg.updatePts, callerMsg.updatePtsCount)],
          [String(call.adminId), String(call.participantId)], [],
        ));
      }

      // Callee (participantId) sees it as incoming in their chat with admin
      const calleePeerKey = `user:${call.adminId}`;
      const calleeMsg = messageStore.appendOutgoingMessage(call.participantId, {
        peerKey: calleePeerKey,
        text: callMeta,
        clientRandomId: `call_hist_part_${callId.toString()}`,
        seedMaxMessageId: 0,
        fromPeerKey: `user:${call.adminId}`,
        actionType: 'phone_call',
      });
      messageStore.markMessageIncoming(call.participantId, calleePeerKey, calleeMsg.messageId);
      const calleeFixture = getStoredMessageAsFixture(calleePeerKey, calleeMsg.messageId, call.participantId);
      if (calleeFixture) {
        ctx.broadcastToUser(call.participantId, buildLiveUpdatesEnvelope(
          [buildUpdateNewMessage(calleeFixture, calleeMsg.updatePts, calleeMsg.updatePtsCount)],
          [String(call.adminId), String(call.participantId)], [],
        ));
      }

      // Return UpdatePhoneCall{discarded} to requester
      return buildLiveUpdatesEnvelope([updateBuf], [String(call.adminId), String(call.participantId)], []);
    }

    // ===== phone.setCallRating#59ead627 — just ack =====
    case 0x59ead627: {
      return buildUpdatesEmpty();
    }

    // ===== phone.sendSignalingData#ff7a9383 peer:InputPhoneCall data:bytes =====
    case 0xff7a9383: {
      const myUserId = session.userId;
      if (!myUserId) return buildBoolTrue();
      const r = new BinaryReader(data.slice(4));
      const { id: callId } = _readInputPhoneCall(r);
      const sigData = Buffer.from(readTlBytesRaw(r));

      const call = _callsMap.get(_callKey(callId));
      if (call) {
        // UpdatePhoneCallSignalingData#2661bf09 phone_call_id:long data:bytes
        const uw = new BinaryWriter();
        uw.writeInt(0x2661bf09);
        uw.writeLong(callId);
        writeTlBytes(uw, sigData);
        const updateBuf = uw.getBytes();

        const otherId = myUserId === call.adminId ? call.participantId : call.adminId;
        const envelope = buildLiveUpdatesEnvelope([updateBuf], [String(call.adminId), String(call.participantId)], []);
        ctx.broadcastToUser(otherId, envelope, session.id);
      }

      return buildBoolTrue();
    }

    case 0x6a3f8d65: { // messages.getAllDrafts
      // Return empty updates — no drafts
      const draftUpdatesW = new BinaryWriter();
      draftUpdatesW.writeInt(0x74ae4240); // updates#74ae4240
      writeEmptyVectorToWriter(draftUpdatesW); // updates
      writeEmptyVectorToWriter(draftUpdatesW); // users
      writeEmptyVectorToWriter(draftUpdatesW); // chats
      draftUpdatesW.writeInt(Math.floor(Date.now() / 1000)); // date
      draftUpdatesW.writeInt(0); // seq
      return draftUpdatesW.getBytes();
    }

    case 0x8bba90e6: { // messages.getMessagesReactions
      // Return updates with no reaction changes
      const reactUpdatesW = new BinaryWriter();
      reactUpdatesW.writeInt(0x74ae4240); // updates#74ae4240
      writeEmptyVectorToWriter(reactUpdatesW); // updates
      writeEmptyVectorToWriter(reactUpdatesW); // users
      writeEmptyVectorToWriter(reactUpdatesW); // chats
      reactUpdatesW.writeInt(Math.floor(Date.now() / 1000)); // date
      reactUpdatesW.writeInt(0); // seq
      return reactUpdatesW.getBytes();
    }

    case 0x1bbcf300: { // messages.getSearchCounters
      // Parse: flags(4) + peer + saved_peer_id? + top_msg_id? + filters:Vector<MessagesFilter>
      // Return: Vector<messages.SearchCounter> with zero counts
      // messages.searchResultsCalendar not supported — return empty vector
      const scW = new BinaryWriter();
      scW.writeInt(0x1cb5c415); // vector
      scW.writeInt(0); // count=0
      return scW.getBytes();
    }

    default: {
      console.log(`[${new Date().toISOString()}] Session ${session.id} unhandled TL: 0x${constructorId.toString(16)}`);
      return buildRpcErrorObject(400, `METHOD_NOT_IMPLEMENTED_0x${constructorId.toString(16)}`);
    }
  }
}
