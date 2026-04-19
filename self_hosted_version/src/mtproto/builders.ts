import { readFileSync, existsSync } from 'fs';
import { resolve as resolvePath, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { BinaryWriter } from './codec.js';
import { writeTlString, writeTlBytes, writeEmptyVectorToWriter, writeBufferVector, writeEmptyJsonObject } from './tlHelpers.js';
import { getMessageStore, type StoredUser, type StoredChat, type StoredChatParticipant, type StoredDraft } from '../database/messageStore.js';
import { generateRandomBytes } from '../crypto/utils.js';
import type {
  FixtureChat,
  FixtureDialog,
  FixtureMessage,
  FixtureUser,
  OfficialCaptureFixture,
} from './officialCaptureFixture.js';
import {
  writePeerByKey,
  writeMessageFromFixture,
  writeUserFromFixture,
  writeFallbackUserFromId,
  writeChatFromFixture,
  writeChatFromDb,
  writeDialogFromFixture,
  writeDialogVector,
  writeMessageVector,
  writeUserVector,
  writeChatVector,
  writePeerNotifySettingsToWriter,
  writePhotoEmpty,
  writePhotoObject,
  writeUpdatesStateToWriter,
  writePeerColorSet,
  writePeerColorProfileSet,
  writeDraftMessage,
  isFieldVisibleByPrivacy,
} from './writers.js';
import {
  SEED_USER_ID,
  listStoredMessagesAsFixture,
  listStoredMessagesAsFixtureForUser,
  getStoredMessageAsFixture,
  mergeMessagesById,
  mergeDialogWithMessages,
  buildTopDialogMessage,
  createDialogFromMessage,
  sliceHistoryMessages,
  collectChatIdsFromMessages,
  collectUserIdsFromMessages,
  collectEntityIdsFromPeerKey,
  getReadStateForPeerKey,
  getFixtureUserForId,
  buildActionForFixture,
} from './fixtureHelpers.js';
import type { ParsedHistoryRequest } from './parsers.js';
import { parseUpdatesDifferenceRequest } from './parsers.js';
import { getActiveSession } from './parsers.js';
import type { ClientSession } from './server.js';

const messageStore = getMessageStore();

/**
 * Check if the current session uses the modern TL schema (GramJS npm / official Telegram).
 * Web client fork (Layer 223) uses older constructor IDs despite higher layer number.
 * GramJS npm (Layer 198) uses newer constructor IDs matching official Telegram servers.
 * When layer is unknown (e.g. no invokeWithLayer sent), defaults to web client format.
 */
function isModernLayer(): boolean {
  const s = getActiveSession();
  if (!s?.layer) return false;
  // Web client fork sends Layer >= 200 with old-format constructors.
  // GramJS npm sends Layer 198 with new-format constructors.
  // Layer < 200 → modern (official TL); Layer >= 200 → web client fork.
  return s.layer < 200;
}

// ========== Config builders ==========

const DC_HOST = process.env.DC_HOST || process.env.DOMAIN || '127.0.0.1';
const DC_PORT = parseInt(process.env.DC_PORT || process.env.TCP_PORT || '8443');

export function buildConfig(): Buffer {
  const w = new BinaryWriter();
  // config#cc1a241e flags:# ... = Config
  w.writeInt(0xcc1a241e);  // config constructor
  w.writeInt((1 << 15));    // flags: reactions_default present
  w.writeInt(Math.floor(Date.now() / 1000)); // date
  w.writeInt(Math.floor(Date.now() / 1000) + 3600); // expires
  w.writeInt(0xbc799737); // test_mode = boolFalse#bc799737
  w.writeInt(2);           // this_dc

  // dc_options: Vector<DcOption>
  w.writeInt(0x1cb5c415);  // vector constructor
  w.writeInt(3);           // count = 3
  // DC 1
  w.writeInt(0x18b7a10d);  // dcOption constructor
  w.writeInt(0);           // flags
  w.writeInt(1);           // id = 1
  writeTlString(w, DC_HOST);
  w.writeInt(DC_PORT);
  // DC 2
  w.writeInt(0x18b7a10d);
  w.writeInt(0);           // flags
  w.writeInt(2);           // id = 2
  writeTlString(w, DC_HOST);
  w.writeInt(DC_PORT);
  // DC 3
  w.writeInt(0x18b7a10d);
  w.writeInt(0);           // flags
  w.writeInt(3);           // id = 3
  writeTlString(w, DC_HOST);
  w.writeInt(DC_PORT);

  writeTlString(w, '');    // dc_txt_domain_name
  w.writeInt(200);         // chat_size_max
  w.writeInt(200000);      // megagroup_size_max
  w.writeInt(100);         // forwarded_count_max
  w.writeInt(60000);       // online_update_period_ms
  w.writeInt(5000);        // offline_blur_timeout_ms
  w.writeInt(30000);       // offline_idle_timeout_ms
  w.writeInt(300000);      // online_cloud_timeout_ms
  w.writeInt(1500);        // notify_cloud_delay_ms
  w.writeInt(25000);       // notify_default_delay_ms
  w.writeInt(60000);       // push_chat_period_ms
  w.writeInt(2);           // push_chat_limit
  w.writeInt(172800);      // edit_time_limit
  w.writeInt(2147483647);  // revoke_time_limit
  w.writeInt(2147483647);  // revoke_pm_time_limit
  w.writeInt(2419200);     // rating_e_decay
  w.writeInt(200);         // stickers_recent_limit
  w.writeInt(604800);      // channels_read_media_period
  // tmp_sessions: flags.0 — NOT present (flag 0 not set)
  w.writeInt(60);          // call_receive_timeout_ms
  w.writeInt(60);          // call_ring_timeout_ms
  w.writeInt(30);          // call_connect_timeout_ms
  w.writeInt(10);          // call_packet_timeout_ms
  writeTlString(w, 'https://localhost/'); // me_url_prefix
  w.writeInt(1024);        // caption_length_max
  w.writeInt(4096);        // message_length_max
  w.writeInt(2);           // webfile_dc_id

  // reactions_default: flags.15 → reactionEmoji#1b2286b8 emoticon:"👍"
  w.writeInt(0x1b2286b8);
  writeTlString(w, '👍');

  return w.getBytes();
}

export function buildAppConfig(): Buffer {
  const w = new BinaryWriter();
  // help.appConfig#dd18782e hash:int config:JSONValue
  w.writeInt(0xdd18782e);
  w.writeInt(0); // hash
  writeEmptyJsonObject(w);
  return w.getBytes();
}

export function buildUpdatesState(selfId?: number): Buffer {
  const w = new BinaryWriter();
  // updates.state#a56c2a3e pts:int qts:int date:int seq:int unread_count:int
  writeUpdatesStateToWriter(w, selfId);
  return w.getBytes();
}

// ========== LangPack builders ==========

const langPackCache = new Map<string, Record<string, string>>();
function loadLangPackStrings(packName: string): Record<string, string> {
  const cached = langPackCache.get(packName);
  if (cached) return cached;

  // Try pack-specific file first, then fall back to langpack-en.json
  const candidates = [
    resolvePath(process.cwd(), 'data', `langpack-${packName}.json`),
    resolvePath(process.cwd(), 'data', 'langpack-en.json'),
  ];

  for (const langPackPath of candidates) {
    if (existsSync(langPackPath)) {
      try {
        const strings = JSON.parse(readFileSync(langPackPath, 'utf8'));
        // console.log(`[LangPack] Loaded ${Object.keys(strings).length} strings for "${packName}" from ${langPackPath}`);
        langPackCache.set(packName, strings);
        return strings;
      } catch (e) {
        console.error(`[LangPack] Failed to load ${langPackPath}:`, e);
      }
    }
  }

  console.warn(`[LangPack] No langpack file for "${packName}" — run scripts/generate-langpack.cjs`);
  const empty = {};
  langPackCache.set(packName, empty);
  return empty;
}

export function buildLangPackDifference(packName: string = 'weba'): Buffer {
  const strings = loadLangPackStrings(packName);
  const entries = Object.entries(strings);

  const w = new BinaryWriter();
  // langPackDifference#f385c1f6 lang_code:string from_version:int version:int strings:Vector<LangPackString>
  w.writeInt(0xf385c1f6);
  writeTlString(w, 'en');  // lang_code
  w.writeInt(0);            // from_version
  w.writeInt(1);            // version
  // strings: Vector<LangPackString>
  w.writeInt(0x1cb5c415);
  w.writeInt(entries.length);
  for (const [key, value] of entries) {
    // langPackString#cad181f6 key:string value:string
    w.writeInt(0xcad181f6);
    writeTlString(w, key);
    writeTlString(w, value);
  }
  return w.getBytes();
}

export function buildLangPackStringsResponse(packName: string, keys: string[]): Buffer {
  const strings = loadLangPackStrings(packName);
  const w = new BinaryWriter();
  // Vector<LangPackString>
  w.writeInt(0x1cb5c415);
  w.writeInt(keys.length);
  for (const key of keys) {
    const value = strings[key];
    if (value !== undefined) {
      // langPackString#cad181f6 key:string value:string
      w.writeInt(0xcad181f6);
      writeTlString(w, key);
      writeTlString(w, value);
    } else {
      // langPackStringDeleted#2979eeb2 key:string
      w.writeInt(0x2979eeb2);
      writeTlString(w, key);
    }
  }
  return w.getBytes();
}

export function buildLangPackLanguage(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0xeeca5ce3);
  w.writeInt(1);             // flags (official = true)
  writeTlString(w, 'English');  // name
  writeTlString(w, 'English');  // native_name
  writeTlString(w, 'en');       // lang_code
  writeTlString(w, 'en');       // plural_code
  w.writeInt(0);                // strings_count
  w.writeInt(0);                // translated_count
  writeTlString(w, '');         // translations_url
  return w.getBytes();
}

export function buildEmptyVector(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x1cb5c415);  // vector constructor
  w.writeInt(0);            // count = 0
  return w.getBytes();
}

// ========== Updates / Difference builders ==========

export function buildUpdatesDifferenceEmpty(selfId: number): Buffer {
  const state = messageStore.getUpdateState(selfId);
  const w = new BinaryWriter();
  // updates.differenceEmpty#5d75a138 date:int seq:int
  w.writeInt(0x5d75a138);
  w.writeInt(state.date);
  w.writeInt(state.seq);
  return w.getBytes();
}

function aggregateStoredReactions(ownerUserId: number, peerKey: string, messageId: number): Array<{ emoticon: string; count: number; chosenOrder?: number }> {
  const stored = messageStore.getReactions(ownerUserId, peerKey, messageId);
  if (!stored || stored.length === 0) return [];
  const map = new Map<string, { count: number; isMine: boolean }>();
  for (const r of stored) {
    const existing = map.get(r.emoticon);
    if (existing) {
      existing.count++;
      if (r.userId === ownerUserId) existing.isMine = true;
    } else {
      map.set(r.emoticon, { count: 1, isMine: r.userId === ownerUserId });
    }
  }
  let chosenIdx = 0;
  return Array.from(map.entries()).map(([emoticon, { count, isMine }]) => ({
    emoticon,
    count,
    chosenOrder: isMine ? chosenIdx++ : undefined,
  }));
}

export function buildUpdatesDifference(data: Buffer, selfId: number): Buffer {
  const request = parseUpdatesDifferenceRequest(data);
  const currentState = messageStore.getUpdateState(selfId);
  const fromPts = request?.pts ?? currentState.pts;
  // console.log(`[GETDIFF] userId=${selfId}, requestPts=${request?.pts}, currentStatePts=${currentState.pts}, fromPts=${fromPts}`);
  const events = messageStore.listUpdateEventsAfter(selfId, fromPts);
  // console.log(`[GETDIFF] Found ${events.length} events after pts=${fromPts}: ${events.map(e => `{kind=${e.kind},pts=${e.pts},msgId=${e.messageId}}`).join(', ')}`);

  if (!events.length) {
    // console.log(`[GETDIFF] Returning differenceEmpty`);
    return buildUpdatesDifferenceEmpty(selfId);
  }

  const newMessages: FixtureMessage[] = [];
  const otherUpdates: Buffer[] = [];
  const userIds: string[] = [];
  const chatIds: string[] = [];

  const seenMessageIds = new Set<number>();

  for (const event of events) {
    collectEntityIdsFromPeerKey(event.peerKey, userIds, chatIds);

    if (event.kind === 'new_message' && event.messageId !== undefined) {
      const stored = messageStore.getMessageForUser(event.messageId, selfId);
      if (stored && !seenMessageIds.has(stored.messageId)) {
        seenMessageIds.add(stored.messageId);
        const isSavedMessages = stored.peerKey === `user:${selfId}`;
        const message: FixtureMessage = {
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
        };
        newMessages.push(message);
        collectEntityIdsFromPeerKey(message.peerKey, userIds, chatIds);
        if (message.fromPeerKey) {
          collectEntityIdsFromPeerKey(message.fromPeerKey, userIds, chatIds);
        }
        if (message.fwdFromPeerKey) {
          collectEntityIdsFromPeerKey(message.fwdFromPeerKey, userIds, chatIds);
        }
      }
      continue;
    }

    if (event.kind === 'edit_message' && event.messageId !== undefined) {
      const editedMsg = messageStore.getMessageForUser(event.messageId, selfId);
      if (editedMsg && !seenMessageIds.has(editedMsg.messageId)) {
        seenMessageIds.add(editedMsg.messageId);
        const isSavedMessages = editedMsg.peerKey === `user:${selfId}`;
        const editFixture: FixtureMessage = {
          id: editedMsg.messageId,
          peerKey: editedMsg.peerKey,
          date: editedMsg.date,
          text: editedMsg.text,
          className: 'Message',
          out: isSavedMessages ? false : editedMsg.isOutgoing,
          post: editedMsg.post,
          fromPeerKey: isSavedMessages ? undefined : editedMsg.fromPeerKey,
          savedPeerKey: isSavedMessages ? `user:${selfId}` : undefined,
          editDate: editedMsg.editDate,
          replyToMsgId: editedMsg.replyToMsgId,
          quoteText: editedMsg.quoteText,
          quoteOffset: editedMsg.quoteOffset,
          mediaId: editedMsg.mediaId,
        };
        otherUpdates.push(buildUpdateEditMessage(editFixture, event.pts, event.ptsCount));
        if (editFixture.fromPeerKey) {
          collectEntityIdsFromPeerKey(editFixture.fromPeerKey, userIds, chatIds);
        }
      }
      continue;
    }

    if (event.kind === 'delete_messages' && event.messageId !== undefined) {
      otherUpdates.push(buildUpdateDeleteMessages([event.messageId], event.pts, event.ptsCount));
      continue;
    }

    if (event.kind === 'reaction' && event.messageId !== undefined) {
      const reactions = aggregateStoredReactions(selfId, event.peerKey, event.messageId);
      const rw = new BinaryWriter();
      // updateMessageReactions#1e297bfa flags:# peer:Peer msg_id:int reactions:MessageReactions
      rw.writeInt(0x1e297bfa);
      rw.writeInt(0); // flags
      writePeerByKey(rw, event.peerKey);
      rw.writeInt(event.messageId);
      // messageReactions#a339f0b flags:# results:Vector<ReactionCount>
      rw.writeInt(0x0a339f0b);
      rw.writeInt(1 << 2); // can_see_list
      rw.writeInt(0x1cb5c415);
      rw.writeInt(reactions.length);
      for (const r of reactions) {
        rw.writeInt(0xa3d1cb80); // reactionCount
        const rcFlags = r.chosenOrder !== undefined ? (1 << 0) : 0;
        rw.writeInt(rcFlags);
        if (r.chosenOrder !== undefined) rw.writeInt(r.chosenOrder);
        rw.writeInt(0x1b2286b8); // reactionEmoji
        writeTlString(rw, r.emoticon);
        rw.writeInt(r.count);
      }
      otherUpdates.push(rw.getBytes());
      continue;
    }

    if (event.kind === 'read_history' && event.maxId !== undefined && !event.peerKey.startsWith('channel:')) {
      otherUpdates.push(buildUpdateReadHistoryInbox(event.peerKey, event.maxId, event.pts, event.ptsCount));
    }

    if (event.kind === 'read_history_outbox' && event.maxId !== undefined && !event.peerKey.startsWith('channel:')) {
      otherUpdates.push(buildUpdateReadHistoryOutbox(event.peerKey, event.maxId, event.pts, event.ptsCount));
    }
  }

  const mergedMessages = mergeMessagesById(newMessages);
  const resolvedUserIds = collectUserIdsFromMessages(userIds, mergedMessages);
  const resolvedChatIds = collectChatIdsFromMessages(chatIds, mergedMessages);

  const w = new BinaryWriter();
  // updates.difference#00f49ca0
  w.writeInt(0x00f49ca0);
  writeMessageVector(w, mergedMessages);
  writeEmptyVectorToWriter(w); // new_encrypted_messages
  writeBufferVector(w, otherUpdates);

  writeEmptyVectorToWriter(w); // chats

  // users
  const allUserIds = Array.from(new Set([String(selfId), ...resolvedUserIds]));
  w.writeInt(0x1cb5c415);
  w.writeInt(allUserIds.length);
  for (const userId of allUserIds) {
    const isSelf = userId === String(selfId);
    writeUserFromFixture(w, getFixtureUserForId(undefined, userId, isSelf), selfId);
  }

  writeUpdatesStateToWriter(w, selfId);
  return w.getBytes();
}

export function buildUpdateReadHistoryInbox(peerKey: string, maxId: number, pts: number, ptsCount: number, selfId?: number): Buffer {
  const w = new BinaryWriter();
  // updateReadHistoryInbox#9e84bc99 flags:# folder_id:flags.0?int peer:Peer top_msg_id:flags.1?int max_id:int still_unread_count:int pts:int pts_count:int
  w.writeInt(0x9e84bc99);
  w.writeInt(0); // flags=0 (no folder_id, no top_msg_id)
  writePeerByKey(w, peerKey);
  w.writeInt(maxId);
  const stillUnread = selfId ? messageStore.getUnreadCount(selfId, peerKey) : 0;
  w.writeInt(stillUnread); // still_unread_count
  w.writeInt(pts);
  w.writeInt(ptsCount);
  return w.getBytes();
}

export function buildUpdateReadHistoryOutbox(peerKey: string, maxId: number, pts: number, ptsCount: number): Buffer {
  const w = new BinaryWriter();
  // updateReadHistoryOutbox#2f2f21bf peer:Peer max_id:int pts:int pts_count:int
  w.writeInt(0x2f2f21bf);
  writePeerByKey(w, peerKey);
  w.writeInt(maxId);
  w.writeInt(pts);
  w.writeInt(ptsCount);
  return w.getBytes();
}

export function buildUpdateNewMessage(message: FixtureMessage, pts: number, ptsCount: number): Buffer {
  const w = new BinaryWriter();
  // updateNewMessage#1f2b0afd message:Message pts:int pts_count:int
  w.writeInt(0x1f2b0afd);
  writeMessageFromFixture(w, message);
  w.writeInt(pts);
  w.writeInt(ptsCount);
  return w.getBytes();
}

export function buildUpdateEditMessage(message: FixtureMessage, pts: number, ptsCount: number): Buffer {
  const w = new BinaryWriter();
  // updateEditMessage#e40370a3 message:Message pts:int pts_count:int
  w.writeInt(0xe40370a3);
  writeMessageFromFixture(w, message);
  w.writeInt(pts);
  w.writeInt(ptsCount);
  return w.getBytes();
}

export function buildUpdateDeleteMessages(messageIds: number[], pts: number, ptsCount: number): Buffer {
  const w = new BinaryWriter();
  // updateDeleteMessages#a20db0e5 messages:Vector<int> pts:int pts_count:int
  w.writeInt(0xa20db0e5);
  w.writeInt(0x1cb5c415); // vector
  w.writeInt(messageIds.length);
  for (const id of messageIds) {
    w.writeInt(id);
  }
  w.writeInt(pts);
  w.writeInt(ptsCount);
  return w.getBytes();
}

export function buildUpdateMessageID(messageId: number, randomId: string): Buffer {
  const w = new BinaryWriter();
  // updateMessageID#4e90bfd6 id:int random_id:long
  w.writeInt(0x4e90bfd6);
  w.writeInt(messageId);
  w.writeLong(BigInt(randomId));
  return w.getBytes();
}

export function buildUpdateUserStatus(userId: number, isOffline: boolean, statusVisible: boolean = true): Buffer {
  const w = new BinaryWriter();
  // updates#74ae4240
  w.writeInt(0x74ae4240);
  // updates: Vector<Update> — 1 item
  w.writeInt(0x1cb5c415);
  w.writeInt(1);
  // updateUserStatus#e5bdf8de user_id:long status:UserStatus
  w.writeInt(0xe5bdf8de);
  w.writeLong(BigInt(userId));
  if (!statusVisible && isOffline) {
    // Privacy hides exact last seen — send approximate "recently" status
    // userStatusRecently#7b197dc8 flags:# by_me:flags.0?true
    w.writeInt(0x7b197dc8);
    w.writeInt(0); // flags (no by_me)
  } else if (isOffline) {
    // userStatusOffline#008c703f was_online:int
    w.writeInt(0x008c703f);
    w.writeInt(Math.floor(Date.now() / 1000));
  } else {
    // userStatusOnline#edb93949 expires:int
    w.writeInt(0xedb93949);
    w.writeInt(Math.floor(Date.now() / 1000) + 300); // online for 5 min
  }
  // users: empty
  w.writeInt(0x1cb5c415);
  w.writeInt(0);
  // chats: empty
  w.writeInt(0x1cb5c415);
  w.writeInt(0);
  // date, seq
  w.writeInt(Math.floor(Date.now() / 1000));
  w.writeInt(0);
  return w.getBytes();
}

export function buildUpdateUserTyping(userId: number, actionConstructor: number): Buffer {
  const w = new BinaryWriter();
  // updates#74ae4240
  w.writeInt(0x74ae4240);
  // updates: Vector<Update> — 1 item
  w.writeInt(0x1cb5c415);
  w.writeInt(1);
  // updateUserTyping#2a17bf5c flags:# user_id:long top_msg_id:flags.0?int action:SendMessageAction
  w.writeInt(0x2a17bf5c);
  w.writeInt(0); // flags (no top_msg_id)
  w.writeLong(BigInt(userId)); // user_id
  w.writeInt(actionConstructor); // action constructor
  // users: empty Vector<User>
  w.writeInt(0x1cb5c415);
  w.writeInt(0);
  // chats: empty Vector<Chat>
  w.writeInt(0x1cb5c415);
  w.writeInt(0);
  // date, seq
  w.writeInt(Math.floor(Date.now() / 1000));
  w.writeInt(0);
  return w.getBytes();
}

export function buildUpdateUserNameUpdate(userId: number, firstName: string, lastName: string, username: string | undefined): Buffer {
  const w = new BinaryWriter();
  // updateUserName#a7848924 user_id:long first_name:string last_name:string usernames:Vector<Username>
  w.writeInt(0xa7848924);
  w.writeLong(BigInt(userId));
  writeTlString(w, firstName);
  writeTlString(w, lastName || '');
  // usernames: Vector<Username>
  w.writeInt(0x1cb5c415);
  if (username) {
    w.writeInt(1);
    // username#b4073647 flags:# editable:flags.0?true active:flags.1?true username:string
    w.writeInt(0xb4073647);
    w.writeInt(3); // flags: bit 0 (editable) + bit 1 (active)
    writeTlString(w, username);
  } else {
    w.writeInt(0); // empty
  }
  return w.getBytes();
}

// ========== Live update envelope ==========

export function buildLiveUpdatesEnvelope(updateBuffers: Buffer[], userIds: string[], chatIds: string[]): Buffer {
  const w = new BinaryWriter();
  // updates#74ae4240 updates:Vector<Update> users:Vector<User> chats:Vector<Chat> date:int seq:int
  w.writeInt(0x74ae4240);
  writeBufferVector(w, updateBuffers);

  // users
  if (userIds.length > 0) {
    w.writeInt(0x1cb5c415);
    w.writeInt(userIds.length);
    for (const userId of userIds) {
      writeUserFromFixture(w, getFixtureUserForId(undefined, userId, false));
    }
  } else {
    writeEmptyVectorToWriter(w);
  }
  writeEmptyVectorToWriter(w); // chats

  w.writeInt(Math.floor(Date.now() / 1000)); // date
  w.writeInt(0); // seq
  return w.getBytes();
}

export function buildLiveNewMessageUpdates(
  peerKey: string,
  messageId: number,
  pts: number,
  ptsCount: number,
): Buffer | null {
  const message = getStoredMessageAsFixture(peerKey, messageId);
  if (!message) {
    return null;
  }

  const userIds: string[] = [];
  const chatIds: string[] = [];
  collectEntityIdsFromPeerKey(message.peerKey, userIds, chatIds);
  if (message.fromPeerKey) {
    collectEntityIdsFromPeerKey(message.fromPeerKey, userIds, chatIds);
  }
  if (message.fwdFromPeerKey) {
    collectEntityIdsFromPeerKey(message.fwdFromPeerKey, userIds, chatIds);
  }

  const update = buildUpdateNewMessage(message, pts, ptsCount);
  return buildLiveUpdatesEnvelope([update], userIds, chatIds);
}

export function buildLiveReadHistoryUpdates(peerKey: string, maxId: number, pts: number, ptsCount: number, selfId?: number): Buffer {
  const userIds: string[] = [];
  const chatIds: string[] = [];
  collectEntityIdsFromPeerKey(peerKey, userIds, chatIds);

  return buildLiveUpdatesEnvelope([
    buildUpdateReadHistoryInbox(peerKey, maxId, pts, ptsCount, selfId),
  ], userIds, chatIds);
}

// ========== User builders ==========

export function buildUserFullForUser(
  session: ClientSession,
  fixture: OfficialCaptureFixture | undefined,
  userId: string,
): Buffer {
  const w = new BinaryWriter();
  // users.userFull#3b6d152e full_user:UserFull chats:Vector<Chat> users:Vector<User>
  w.writeInt(0x3b6d152e);
  const user = getFixtureUserForId(fixture, userId);
  const selfId = session.userId || SEED_USER_ID;
  const isSelf = String(selfId) === userId;
  const targetUserId = Number(userId);

  // Privacy checks for non-self views
  const aboutVisible = isSelf || isFieldVisibleByPrivacy(targetUserId, selfId, 'about');
  const birthdayVisible = isSelf || isFieldVisibleByPrivacy(targetUserId, selfId, 'birthday');
  const profilePhotoVisible = isSelf || isFieldVisibleByPrivacy(targetUserId, selfId, 'profilePhoto');
  const phoneCallVisible = isSelf || isFieldVisibleByPrivacy(targetUserId, selfId, 'phoneCall');
  const voiceMessagesVisible = isSelf || isFieldVisibleByPrivacy(targetUserId, selfId, 'voiceMessages');

  console.log(`[UserFull] userId=${userId} isSelf=${isSelf} about="${user.about || ''}" aboutVisible=${aboutVisible} birthdayVisible=${birthdayVisible} photoId=${user.photoId || 'none'}`);

  // --- UserFull#a02bc13e ---
  // flags: # blocked:flags.0?true phone_calls_available:flags.4?true phone_calls_private:flags.5?true
  //   can_pin_message:flags.7?true has_scheduled:flags.12?true video_calls_available:flags.13?true
  //   voice_messages_forbidden:flags.20?true translations_disabled:flags.23?true
  //   stories_pinned_available:flags.26?true blocked_my_stories_from:flags.27?true
  //   wallpaper_overridden:flags.28?true contact_require_premium:flags.29?true read_dates_private:flags.30?true
  let ufFlags = 0;
  ufFlags |= (1 << 7); // can_pin_message (always)
  if (phoneCallVisible && user.phoneCallsAvailable) ufFlags |= (1 << 4);
  if (user.phoneCallsPrivate) ufFlags |= (1 << 5);
  if (phoneCallVisible && user.videoCallsAvailable) ufFlags |= (1 << 13);
  if (!voiceMessagesVisible || user.voiceMessagesForbidden) ufFlags |= (1 << 20);
  if (user.contactRequirePremium) ufFlags |= (1 << 29);
  if (aboutVisible && user.about) ufFlags |= (1 << 1); // about present
  // profilePhoto from user.photoId
  const profilePhotoMedia = (profilePhotoVisible && user.photoId) ? messageStore.getMedia(user.photoId) : undefined;
  if (profilePhotoMedia) ufFlags |= (1 << 2); // profile_photo present
  if (user.bot && user.botInfoVersion) ufFlags |= (1 << 3); // bot_info present
  if (user.pinnedMsgId) ufFlags |= (1 << 6); // pinned_msg_id present
  if (user.ttlPeriod) ufFlags |= (1 << 14); // ttl_period present
  if (user.themeEmoticon) ufFlags |= (1 << 15); // theme_emoticon present
  if (user.privateForwardName) ufFlags |= (1 << 16); // private_forward_name present
  // premiumGifts: skip (complex)
  // wallpaper: skip
  // stories: skip

  // flags2: # sponsored_enabled:flags2.7?true can_view_revenue:flags2.9?true bot_can_manage_emoji_status:flags2.10?true
  let ufFlags2 = 0;
  if (birthdayVisible && user.birthdayDay) ufFlags2 |= (1 << 5); // birthday present
  if (user.personalChannelId) ufFlags2 |= (1 << 6); // personal_channel_id + message present
  if (user.stargiftsCount) ufFlags2 |= (1 << 8); // stargifts_count present

  w.writeInt(0xa02bc13e);
  w.writeInt(ufFlags);
  w.writeInt(ufFlags2);
  w.writeLong(BigInt(user.id));

  // about (flags.1)
  if (aboutVisible && user.about) {
    writeTlString(w, user.about);
  }

  // settings: PeerSettings#f47741f7 flags:#
  w.writeInt(0xf47741f7);
  w.writeInt(0);

  // personal_photo (flags.21) — skip
  // profile_photo (flags.2)
  if (profilePhotoMedia) {
    writePhotoObject(w, profilePhotoMedia);
  }
  // fallback_photo (flags.22) — skip

  // notify_settings: PeerNotifySettings
  writePeerNotifySettingsToWriter(w);

  // bot_info (flags.3)
  if (user.bot && user.botInfoVersion) {
    // botInfo#8f300b57 flags:# user_id:flags.0?long description:flags.1?string ...
    w.writeInt(0x8f300b57);
    let biFlags = (1 << 0); // user_id present
    w.writeInt(biFlags);
    w.writeLong(BigInt(user.id));
    // no description, no commands — minimal stub
  }

  // pinned_msg_id (flags.6)
  if (user.pinnedMsgId) {
    w.writeInt(user.pinnedMsgId);
  }

  // common_chats_count
  w.writeInt(user.commonChatsCount || 0);

  // folder_id: skip (not in flags)
  // ttl_period (flags.14)
  if (user.ttlPeriod) {
    w.writeInt(user.ttlPeriod);
  }
  // theme_emoticon (flags.15)
  if (user.themeEmoticon) {
    writeTlString(w, user.themeEmoticon);
  }
  // private_forward_name (flags.16)
  if (user.privateForwardName) {
    writeTlString(w, user.privateForwardName);
  }
  // bot_group_admin_rights: skip
  // bot_broadcast_admin_rights: skip
  // premium_gifts: skip
  // wallpaper: skip
  // stories: skip
  // business*: skip

  // birthday (flags2.5)
  if (birthdayVisible && user.birthdayDay) {
    // birthday#6c8e1e06 flags:# day:int month:int year:flags.0?int
    w.writeInt(0x6c8e1e06);
    let bFlags = 0;
    if (user.birthdayYear) bFlags |= (1 << 0);
    w.writeInt(bFlags);
    w.writeInt(user.birthdayDay);
    w.writeInt(user.birthdayMonth || 1);
    if (user.birthdayYear) {
      w.writeInt(user.birthdayYear);
    }
  }

  // personal_channel_id + personal_channel_message (flags2.6)
  if (user.personalChannelId) {
    w.writeLong(BigInt(user.personalChannelId));
    w.writeInt(user.personalChannelMessage || 0);
  }

  // stargifts_count (flags2.8)
  if (user.stargiftsCount) {
    w.writeInt(user.stargiftsCount);
  }

  // starref_program: skip
  // bot_verification: skip

  // --- chats: Vector<Chat> ---
  w.writeInt(0x1cb5c415);
  w.writeInt(0);

  // --- users: Vector<User> ---
  w.writeInt(0x1cb5c415);
  w.writeInt(1);
  writeUserFromFixture(w, user, selfId);

  return w.getBytes();
}

export function buildUsersVector(session: ClientSession): Buffer {
  return buildUsersVectorForIds(session, undefined, [String(session.userId || SEED_USER_ID)]);
}

export function buildUsersVectorForIds(
  session: ClientSession,
  fixture: OfficialCaptureFixture | undefined,
  userIds: string[],
): Buffer {
  const w = new BinaryWriter();
  // Vector<User>
  w.writeInt(0x1cb5c415);
  const uniqueUserIds = Array.from(new Set(userIds));
  w.writeInt(uniqueUserIds.length);
  const selfId = String(session.userId || SEED_USER_ID);
  const selfIdNum = session.userId || SEED_USER_ID;
  for (const userId of uniqueUserIds) {
    const isSelf = userId === selfId;
    writeUserFromFixture(w, getFixtureUserForId(fixture, userId, isSelf), selfIdNum);
  }
  return w.getBytes();
}

// ========== Dialog builders ==========

export function buildDialogFilters(): Buffer {
  const w = new BinaryWriter();
  // messages.dialogFilters#2ad93719 flags:# tags_enabled:flags.0?true filters:Vector<DialogFilter>
  w.writeInt(0x2ad93719);
  w.writeInt(0);
  w.writeInt(0x1cb5c415);
  w.writeInt(0);
  return w.getBytes();
}

export function buildDialogsEmpty(): Buffer {
  const w = new BinaryWriter();
  // messages.dialogs#15ba6c40
  w.writeInt(0x15ba6c40);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  return w.getBytes();
}

export function buildDialogsFromDb(selfId: number): Buffer {
  const peerKeys = messageStore.getDialogPeerKeysForUser(selfId);

  // Always include Saved Messages (user:selfId) even with no messages
  const savedPeerKey = `user:${selfId}`;
  const hasSavedMessages = peerKeys.includes(savedPeerKey);

  if (peerKeys.length === 0 && !hasSavedMessages) {
    // Still include Saved Messages as empty dialog
  }

  const dialogData: Array<{
    peerKey: string;
    topMessage: import('../database/messageStore.js').StoredMessage | null;
  }> = [];
  const userIdSet = new Set<string>([String(selfId)]);
  const chatIdSet = new Set<number>();

  for (const peerKey of peerKeys) {
    const lastMsg = messageStore.getLastMessageForUser(peerKey, selfId);
    if (!lastMsg) continue;
    dialogData.push({ peerKey, topMessage: lastMsg });
    if (peerKey.startsWith('user:')) {
      userIdSet.add(peerKey.replace('user:', ''));
    } else if (peerKey.startsWith('chat:') || peerKey.startsWith('channel:')) {
      chatIdSet.add(Number(peerKey.split(':')[1]));
    }
    if (lastMsg.fromPeerKey?.startsWith('user:')) {
      userIdSet.add(lastMsg.fromPeerKey.replace('user:', ''));
    }
    if (lastMsg.fwdFromPeerKey?.startsWith('user:')) {
      userIdSet.add(lastMsg.fwdFromPeerKey.replace('user:', ''));
    }
  }

  // Ensure Saved Messages is always in the dialog list
  if (!hasSavedMessages) {
    dialogData.push({ peerKey: savedPeerKey, topMessage: null });
  }

  // Also load drafts to enrich dialogs
  const drafts = messageStore.getAllDrafts(selfId);
  const draftsByPeer = new Map<string, StoredDraft>();
  for (const d of drafts) {
    draftsByPeer.set(d.peerKey, d);
  }

  dialogData.sort((a, b) => (b.topMessage?.date || 0) - (a.topMessage?.date || 0));

  const w = new BinaryWriter();
  // messages.dialogs#15ba6c40
  w.writeInt(0x15ba6c40);

  // dialogs: Vector<Dialog>
  w.writeInt(0x1cb5c415);
  w.writeInt(dialogData.length);
  for (const { peerKey, topMessage } of dialogData) {
    const peerState = messageStore.getPeerState(selfId, peerKey);
    const draft = draftsByPeer.get(peerKey);
    w.writeInt(0xd58a08c6);
    let dialogFlags = 0;
    if (draft) dialogFlags |= (1 << 1); // draft present
    w.writeInt(dialogFlags);
    writePeerByKey(w, peerKey);
    w.writeInt(topMessage?.messageId || 0);
    w.writeInt(peerState?.readInboxMaxId || 0);
    w.writeInt(peerState?.readOutboxMaxId || 0);
    const unreadCount = messageStore.getUnreadCount(selfId, peerKey);
    w.writeInt(unreadCount);
    w.writeInt(0); // unread_mentions_count
    w.writeInt(0); // unread_reactions_count
    writePeerNotifySettingsToWriter(w);
    if (draft) {
      writeDraftMessage(w, draft.text, draft.date, draft.replyToMsgId);
    }
  }

  // messages: Vector<Message> — only for dialogs that have a top message
  const dialogsWithMessages = dialogData.filter(d => d.topMessage !== null);
  w.writeInt(0x1cb5c415);
  w.writeInt(dialogsWithMessages.length);
  for (const { peerKey, topMessage } of dialogsWithMessages) {
    const isSavedMessages = peerKey === `user:${selfId}`;
    const fixtureMsg: FixtureMessage = {
      id: topMessage!.messageId,
      peerKey: topMessage!.peerKey,
      date: topMessage!.date,
      text: topMessage!.text,
      className: topMessage!.actionType ? 'MessageService' : 'Message',
      out: isSavedMessages ? false : topMessage!.isOutgoing,
      post: topMessage!.post,
      fromPeerKey: isSavedMessages ? undefined : topMessage!.fromPeerKey,
      savedPeerKey: isSavedMessages ? `user:${selfId}` : undefined,
      replyToMsgId: topMessage!.replyToMsgId,
      quoteText: topMessage!.quoteText,
      quoteOffset: topMessage!.quoteOffset,
      mediaId: topMessage!.mediaId,
      fwdFromPeerKey: topMessage!.fwdFromPeerKey,
      fwdFromName: topMessage!.fwdFromName,
      fwdDate: topMessage!.fwdDate,
      action: buildActionForFixture(topMessage!.peerKey, topMessage!.actionType, topMessage!.text, topMessage!.mediaId),
    };
    writeMessageFromFixture(w, fixtureMsg);
  }

  // chats: Vector<Chat>
  const chatIds = Array.from(chatIdSet);
  w.writeInt(0x1cb5c415);
  w.writeInt(chatIds.length);
  for (const chatId of chatIds) {
    const chat = messageStore.getChatById(chatId);
    if (chat) {
      writeChatFromDb(w, chat, selfId);
    }
  }

  // users
  const userIds = Array.from(userIdSet);
  w.writeInt(0x1cb5c415);
  w.writeInt(userIds.length);
  for (const userId of userIds) {
    const isSelf = userId === String(selfId);
    writeUserFromFixture(w, getFixtureUserForId(undefined, userId, isSelf), selfId);
  }

  return w.getBytes();
}

export function buildPeerDialogsForPeers(peerKeys: string[], selfId: number): Buffer {
  const w = new BinaryWriter();
  // messages.peerDialogs#3371c354
  w.writeInt(0x3371c354);

  const userIdSet = new Set<string>([String(selfId)]);

  // dialogs
  w.writeInt(0x1cb5c415);
  w.writeInt(peerKeys.length);
  for (const peerKey of peerKeys) {
    const lastMsg = messageStore.getLastMessageForUser(peerKey, selfId);
    const peerState = messageStore.getPeerState(selfId, peerKey);
    w.writeInt(0xd58a08c6);
    w.writeInt(0);
    writePeerByKey(w, peerKey);
    w.writeInt(lastMsg?.messageId || 0);
    w.writeInt(peerState?.readInboxMaxId || 0);
    w.writeInt(peerState?.readOutboxMaxId || 0);
    const peerUnread = messageStore.getUnreadCount(selfId, peerKey);
    w.writeInt(peerUnread);
    w.writeInt(0);
    w.writeInt(0);
    writePeerNotifySettingsToWriter(w);
    if (peerKey.startsWith('user:')) {
      userIdSet.add(peerKey.replace('user:', ''));
    }
  }

  // messages
  const topMessages: FixtureMessage[] = [];
  const chatIdSet = new Set<number>();
  for (const peerKey of peerKeys) {
    const lastMsg = messageStore.getLastMessageForUser(peerKey, selfId);
    if (peerKey.startsWith('chat:') || peerKey.startsWith('channel:')) {
      chatIdSet.add(Number(peerKey.split(':')[1]));
    }
    if (lastMsg) {
      const isSavedMessages = peerKey === `user:${selfId}`;
      topMessages.push({
        id: lastMsg.messageId,
        peerKey: lastMsg.peerKey,
        date: lastMsg.date,
        text: lastMsg.text,
        className: lastMsg.actionType ? 'MessageService' : 'Message',
        out: isSavedMessages ? false : lastMsg.isOutgoing,
        post: lastMsg.post,
        fromPeerKey: isSavedMessages ? undefined : lastMsg.fromPeerKey,
        savedPeerKey: isSavedMessages ? `user:${selfId}` : undefined,
        replyToMsgId: lastMsg.replyToMsgId,
        quoteText: lastMsg.quoteText,
        quoteOffset: lastMsg.quoteOffset,
        mediaId: lastMsg.mediaId,
        fwdFromPeerKey: lastMsg.fwdFromPeerKey,
        fwdFromName: lastMsg.fwdFromName,
        fwdDate: lastMsg.fwdDate,
        action: buildActionForFixture(lastMsg.peerKey, lastMsg.actionType, lastMsg.text, lastMsg.mediaId),
      });
      if (lastMsg.fromPeerKey?.startsWith('user:')) userIdSet.add(lastMsg.fromPeerKey.replace('user:', ''));
      if (lastMsg.fwdFromPeerKey?.startsWith('user:')) userIdSet.add(lastMsg.fwdFromPeerKey.replace('user:', ''));
    }
  }
  w.writeInt(0x1cb5c415);
  w.writeInt(topMessages.length);
  for (const msg of topMessages) {
    writeMessageFromFixture(w, msg);
  }

  // chats
  const chatIds = Array.from(chatIdSet);
  w.writeInt(0x1cb5c415);
  w.writeInt(chatIds.length);
  for (const chatId of chatIds) {
    const chat = messageStore.getChatById(chatId);
    if (chat) {
      writeChatFromDb(w, chat, selfId);
    }
  }

  // users
  const userIds = Array.from(userIdSet);
  w.writeInt(0x1cb5c415);
  w.writeInt(userIds.length);
  for (const userId of userIds) {
    const isSelf = userId === String(selfId);
    writeUserFromFixture(w, getFixtureUserForId(undefined, userId, isSelf), selfId);
  }

  // state
  writeUpdatesStateToWriter(w, selfId);
  return w.getBytes();
}

export function buildPinnedDialogs(selfId?: number): Buffer {
  const w = new BinaryWriter();
  // messages.peerDialogs#3371c354
  w.writeInt(0x3371c354);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  writeUpdatesStateToWriter(w, selfId);
  return w.getBytes();
}

// ========== Messages response builders ==========

export function buildGetMessagesResponse(messages: FixtureMessage[], fixture?: OfficialCaptureFixture | null, selfId?: number): Buffer {
  const w = new BinaryWriter();
  const modern = isModernLayer();
  w.writeInt(modern ? 0x8c718e87 : 0x1d73e7ea);
  writeMessageVector(w, messages);
  if (!modern) writeEmptyVectorToWriter(w); // topics (web client schema)

  const effectiveSelfId = selfId ?? SEED_USER_ID;
  const userIdSet = new Set<string>([String(effectiveSelfId)]);
  const chatIds: string[] = [];
  for (const msg of messages) {
    collectEntityIdsFromPeerKey(msg.peerKey, [], chatIds);
    if (msg.peerKey.startsWith('user:')) userIdSet.add(msg.peerKey.replace('user:', ''));
    if (msg.fromPeerKey?.startsWith('user:')) userIdSet.add(msg.fromPeerKey.replace('user:', ''));
    if (msg.fwdFromPeerKey) {
      if (msg.fwdFromPeerKey.startsWith('user:')) userIdSet.add(msg.fwdFromPeerKey.replace('user:', ''));
      else collectEntityIdsFromPeerKey(msg.fwdFromPeerKey, [], chatIds);
    }
  }

  if (fixture) {
    writeChatVector(w, fixture, chatIds);
    writeUserVector(w, fixture, Array.from(userIdSet));
  } else {
    // Write chats vector
    const uniqueChatIds = Array.from(new Set(chatIds));
    if (uniqueChatIds.length > 0) {
      w.writeInt(0x1cb5c415);
      w.writeInt(uniqueChatIds.length);
      for (const cid of uniqueChatIds) {
        const chatIdNum = Number(cid);
        const chatObj = messageStore.getChatById(chatIdNum);
        if (chatObj) {
          writeChatFromDb(w, chatObj, effectiveSelfId);
        }
      }
    } else {
      writeEmptyVectorToWriter(w);
    }
    const uIds = Array.from(userIdSet);
    w.writeInt(0x1cb5c415);
    w.writeInt(uIds.length);
    for (const userId of uIds) {
      const isSelf = userId === String(effectiveSelfId);
      writeUserFromFixture(w, getFixtureUserForId(undefined, userId, isSelf), effectiveSelfId);
    }
  }
  return w.getBytes();
}

export function buildMessagesSliceEmpty(): Buffer {
  const w = new BinaryWriter();
  const modern = isModernLayer();
  w.writeInt(modern ? 0x3a54685e : 0x5f206716);
  w.writeInt(0); w.writeInt(0);
  writeEmptyVectorToWriter(w);
  if (!modern) writeEmptyVectorToWriter(w); // topics (web client schema)
  writeEmptyVectorToWriter(w);
  writeEmptyVectorToWriter(w);
  return w.getBytes();
}

export function buildMessagesEmpty(): Buffer {
  const w = new BinaryWriter();
  const modern = isModernLayer();
  w.writeInt(modern ? 0x8c718e87 : 0x1d73e7ea);
  writeEmptyVectorToWriter(w);
  if (!modern) writeEmptyVectorToWriter(w); // topics (web client schema)
  writeEmptyVectorToWriter(w);
  writeEmptyVectorToWriter(w);
  return w.getBytes();
}

export function buildWebPagePreviewEmpty(): Buffer {
  const w = new BinaryWriter();
  const modern = isModernLayer();
  w.writeInt(modern ? 0xb53e8b21 : 0x8c9a88ac);
  w.writeInt(0x3ded6320); // messageMediaEmpty
  if (!modern) writeEmptyVectorToWriter(w); // chats (web client schema)
  writeEmptyVectorToWriter(w); // users
  return w.getBytes();
}

export function buildRecentStoriesVector(count: number): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x1cb5c415);
  w.writeInt(count);
  for (let index = 0; index < count; index++) {
    w.writeInt(0x711d692d);
    w.writeInt(0);
  }
  return w.getBytes();
}

export function buildTermsOfServiceUpdateEmpty(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0xe3309f7f); // help.TermsOfServiceUpdateEmpty (Layer 198)
  w.writeInt(Math.floor(Date.now() / 1000) + 86400); // expires (24h from now)
  return w.getBytes();
}

// ========== Auth builders ==========

export function buildSentCode(phoneCodeHash: string, codeLength: number): Buffer {
  const w = new BinaryWriter();
  const flags = (1 << 2);
  w.writeInt(0x5e002502);
  w.writeInt(flags);
  w.writeInt(0x3dbb5986);
  w.writeInt(codeLength);
  writeTlString(w, phoneCodeHash);
  w.writeInt(300);
  return w.getBytes();
}

export function buildAuthAuthorization(user: StoredUser): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x2ea2c0d4);
  w.writeInt(0);
  writeUserFromFixture(w, {
    id: String(user.id),
    accessHash: user.accessHash.toString(),
    firstName: user.firstName,
    lastName: user.lastName || undefined,
    username: user.username,
    phone: user.phone,
    photoId: user.photoId,
    self: true,
    premium: user.premium,
  });
  return w.getBytes();
}

export function buildAuthSignUpRequired(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x44747e9a);
  w.writeInt(0);
  return w.getBytes();
}

export function buildLoginToken(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x629f1980);
  w.writeInt(Math.floor(Date.now() / 1000) + 30);
  const token = generateRandomBytes(32);
  writeTlBytes(w, token);
  return w.getBytes();
}

// ========== Contacts builders ==========

export function buildContactsFromDb(selfId: number): Buffer {
  const allUsers = messageStore.getAllUsers(selfId);
  const w = new BinaryWriter();
  w.writeInt(0xeae87e42);
  w.writeInt(0x1cb5c415);
  w.writeInt(allUsers.length);
  for (const user of allUsers) {
    w.writeInt(0x145ade0b);
    w.writeLong(BigInt(user.id));
    w.writeInt(0x997275b5);
  }
  w.writeInt(allUsers.length);
  w.writeInt(0x1cb5c415);
  w.writeInt(allUsers.length);
  for (const user of allUsers) {
    writeUserFromFixture(w, {
      id: String(user.id),
      accessHash: user.accessHash.toString(),
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      contact: true,
    });
  }
  return w.getBytes();
}

export function buildContactsFound(query: string, selfId: number): Buffer {
  const foundUsers = messageStore.searchUsers(query, selfId);
  const w = new BinaryWriter();
  w.writeInt(0xb3134d9d);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415);
  w.writeInt(foundUsers.length);
  for (const user of foundUsers) {
    w.writeInt(0x59511722);
    w.writeLong(BigInt(user.id));
  }
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415);
  w.writeInt(foundUsers.length);
  for (const user of foundUsers) {
    writeUserFromFixture(w, {
      id: String(user.id),
      accessHash: user.accessHash.toString(),
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      contact: true,
    });
  }
  return w.getBytes();
}

export function buildResolvedPeer(username: string): Buffer {
  const user = messageStore.getUserByUsername(username);
  if (!user) {
    return buildRpcErrorObject(400, 'USERNAME_NOT_OCCUPIED');
  }
  return buildResolvedPeerForUser(user);
}

export function buildResolvedPeerForUser(user: StoredUser): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x7f077ad9);
  w.writeInt(0x59511722);
  w.writeLong(BigInt(user.id));
  writeEmptyVectorToWriter(w);
  w.writeInt(0x1cb5c415);
  w.writeInt(1);
  writeUserFromFixture(w, {
    id: String(user.id),
    accessHash: user.accessHash.toString(),
    firstName: user.firstName,
    lastName: user.lastName || undefined,
    username: user.username,
    phone: user.phone,
  });
  return w.getBytes();
}

// ========== Channel builders ==========

export function buildChannelFullEmpty(channelId = '0'): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0xe5d7d19c);
  w.writeInt(0xe4e0b29d);
  w.writeInt(0); w.writeInt(0);
  w.writeLong(BigInt(channelId));
  writeTlString(w, '');
  w.writeInt(0); w.writeInt(0); w.writeInt(0);
  writePhotoEmpty(w, 0n);
  writePeerNotifySettingsToWriter(w);
  writeEmptyVectorToWriter(w);
  w.writeInt(messageStore.getUpdateState().pts);
  writeEmptyVectorToWriter(w);
  writeEmptyVectorToWriter(w);
  return w.getBytes();
}

// ========== Simple stub builders ==========

export function buildBoolTrue(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x997275b5);
  return w.getBytes();
}

export function buildBoolFalse(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0xbc799737);
  return w.getBytes();
}

export function buildNearestDc(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x8e1a1775);
  writeTlString(w, 'US');
  w.writeInt(2); w.writeInt(2);
  return w.getBytes();
}

export function buildPeerNotifySettings(): Buffer {
  const w = new BinaryWriter();
  writePeerNotifySettingsToWriter(w);
  return w.getBytes();
}

export function buildPeerColorsEmpty(): Buffer {
  return buildPeerColors(false);
}

export function buildPeerProfileColors(): Buffer {
  return buildPeerColors(true);
}

function buildPeerColors(isProfile: boolean): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x00f8ed08);
  w.writeInt(1);
  w.writeInt(0x1cb5c415);
  w.writeInt(7);

  const lightPalettes = [
    [0xd67722, 0xe89f3c, 0xf2c05a],
    [0xc7508b, 0xdb6aa3, 0xee95c2],
    [0x3f8fce, 0x61a9e6, 0x8ac4f4],
    [0x3aa86f, 0x5bbf86, 0x84d7a8],
    [0x665fff, 0x817aff, 0xa49eff],
    [0xba6a2f, 0xcf8751, 0xe4a674],
    [0x9a5fd1, 0xb07ae2, 0xc99cf0],
  ];
  const darkPalettes = [
    [0xa35314, 0xbf6a1a, 0xd88a35],
    [0x963062, 0xaf4478, 0xca6797],
    [0x276d9f, 0x3187bb, 0x54a5d7],
    [0x27734c, 0x2f8758, 0x46a66f],
    [0x4d49c4, 0x625de0, 0x7f79f0],
    [0x885223, 0x9e6631, 0xb5804f],
    [0x6f43a5, 0x8758be, 0xa072d6],
  ];

  for (let colorId = 0; colorId < 7; colorId++) {
    w.writeInt(0xadec6ebe);
    w.writeInt((1 << 1) | (1 << 2));
    w.writeInt(colorId);
    if (isProfile) {
      writePeerColorProfileSet(w, lightPalettes[colorId]);
      writePeerColorProfileSet(w, darkPalettes[colorId]);
    } else {
      writePeerColorSet(w, lightPalettes[colorId]);
      writePeerColorSet(w, darkPalettes[colorId]);
    }
  }

  return w.getBytes();
}

export function buildCountriesListEmpty(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x87d0759e);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0);
  return w.getBytes();
}

export function buildPromoDataEmpty(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x98f6ac75);
  w.writeInt(Math.floor(Date.now() / 1000) + 86400);
  return w.getBytes();
}

export function buildAuthorizationsEmpty(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x4bff8ea0);  // account.authorizations
  w.writeInt(90);           // authorization_ttl_days
  w.writeInt(0x1cb5c415); w.writeInt(0); // empty vector
  return w.getBytes();
}

export function buildAuthorizations(
  sessions: Array<{
    authKeyHex: string;
    deviceModel: string;
    platform: string;
    appVersion: string;
    createdAt: number;
    lastActivityAt: number;
  }>,
  currentAuthKeyHex?: string,
): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x4bff8ea0);  // account.authorizations
  w.writeInt(90);           // authorization_ttl_days
  w.writeInt(0x1cb5c415);  // vector
  w.writeInt(sessions.length);
  for (const sess of sessions) {
    const isCurrent = sess.authKeyHex === currentAuthKeyHex;
    const flags = (isCurrent ? 1 : 0) | (1 << 1); // current | official_app
    w.writeInt(0xad01d61d); // authorization constructor
    w.writeInt(flags);
    // hash: use first 8 bytes of authKeyHex as a stable int64
    const hashBuf = Buffer.alloc(8);
    const hexPart = sess.authKeyHex.padEnd(16, '0').slice(0, 16);
    hashBuf.write(hexPart, 'hex');
    w.writeLong(hashBuf.readBigInt64LE(0));
    writeTlString(w, sess.deviceModel || 'Unknown');          // device_model
    writeTlString(w, sess.platform || 'Unknown');              // platform
    writeTlString(w, sess.platform || 'Unknown');              // system_version
    w.writeInt(1);                                             // api_id
    writeTlString(w, 'Pluma Chat');                            // app_name
    writeTlString(w, sess.appVersion || '1.0.0');              // app_version
    w.writeInt(sess.createdAt);                                // date_created
    w.writeInt(sess.lastActivityAt);                           // date_active
    writeTlString(w, '');                                      // ip
    writeTlString(w, '');                                      // country
    writeTlString(w, '');                                      // region
  }
  return w.getBytes();
}

export function buildWallPapersNotModified(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x1c199183);
  return w.getBytes();
}

export function buildStickerSetNotModified(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0xd3f924eb);
  return w.getBytes();
}

function writeReactionTl(w: BinaryWriter, emoticon: string): void {
  if (emoticon.startsWith('custom:')) {
    // reactionCustomEmoji#8935fc73 document_id:long
    w.writeInt(0x8935fc73);
    w.writeLong(BigInt(emoticon.slice(7)));
  } else {
    // reactionEmoji#1b2286b8 emoticon:string
    w.writeInt(0x1b2286b8);
    writeTlString(w, emoticon);
  }
}

function writeReactionCountsVector(w: BinaryWriter, reactions: Array<{ emoticon: string; count: number; chosenOrder?: number }>): void {
  w.writeInt(0x1cb5c415);
  w.writeInt(reactions.length);
  for (const r of reactions) {
    // reactionCount#a3d1cb80 flags:# chosen_order:flags.0?int reaction:Reaction count:int
    w.writeInt(0xa3d1cb80);
    const rcFlags = r.chosenOrder !== undefined ? (1 << 0) : 0;
    w.writeInt(rcFlags);
    if (r.chosenOrder !== undefined) {
      w.writeInt(r.chosenOrder);
    }
    writeReactionTl(w, r.emoticon);
    w.writeInt(r.count);
  }
}

export function buildUpdateMessageReactions(
  peerKey: string,
  msgId: number,
  reactions: Array<{ emoticon: string; count: number; chosenOrder?: number }>,
): Buffer {
  const w = new BinaryWriter();
  // updates#74ae4240
  w.writeInt(0x74ae4240);
  // updates: Vector<Update> — 1 item
  w.writeInt(0x1cb5c415);
  w.writeInt(1);
  // updateMessageReactions#1e297bfa flags:# peer:Peer msg_id:int top_msg_id:flags.0?int saved_peer_id:flags.1?Peer reactions:MessageReactions
  w.writeInt(0x1e297bfa);
  w.writeInt(0); // flags — no optional fields
  writePeerByKey(w, peerKey);
  w.writeInt(msgId);
  // messageReactions#a339f0b
  w.writeInt(0x0a339f0b);
  const mrFlags = (1 << 2); // can_see_list
  w.writeInt(mrFlags);
  // results: Vector<ReactionCount>
  writeReactionCountsVector(w, reactions);
  // users: empty
  w.writeInt(0x1cb5c415); w.writeInt(0);
  // chats: empty
  w.writeInt(0x1cb5c415); w.writeInt(0);
  // date, seq
  w.writeInt(Math.floor(Date.now() / 1000));
  w.writeInt(0);
  return w.getBytes();
}

export function buildLiveUpdateMessageReactions(
  peerKey: string,
  msgId: number,
  reactions: Array<{ emoticon: string; count: number; chosenOrder?: number }>,
): Buffer {
  const userIds: string[] = [];
  const chatIds: string[] = [];
  collectEntityIdsFromPeerKey(peerKey, userIds, chatIds);

  const w = new BinaryWriter();
  // updateMessageReactions#1e297bfa
  w.writeInt(0x1e297bfa);
  w.writeInt(0); // flags
  writePeerByKey(w, peerKey);
  w.writeInt(msgId);
  // messageReactions#a339f0b
  w.writeInt(0x0a339f0b);
  const mrFlags = (1 << 2); // can_see_list
  w.writeInt(mrFlags);
  writeReactionCountsVector(w, reactions);
  return buildLiveUpdatesEnvelope([w.getBytes()], userIds, chatIds);
}

export function buildUpdatesEmpty(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x74ae4240);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(Math.floor(Date.now() / 1000));
  w.writeInt(0);
  return w.getBytes();
}

export function buildTopPeersDisabled(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0xb52c939d);
  return w.getBytes();
}

export function buildBlockedEmpty(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x0ade1591);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  return w.getBytes();
}

export function buildAvailableReactionsNotModified(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x9f071957);
  return w.getBytes();
}

// Cached raw TL bytes captured from official Telegram servers
let _cachedAvailableReactions: Buffer | undefined;

export function buildAvailableReactions(): Buffer {
  if (_cachedAvailableReactions) return _cachedAvailableReactions;
  const binPath = resolvePath(__dirname, '../../data/available_reactions.bin');
  if (existsSync(binPath)) {
    _cachedAvailableReactions = readFileSync(binPath);
    console.log(`[REACTIONS] Loaded available_reactions.bin: ${_cachedAvailableReactions.length} bytes`);
    return _cachedAvailableReactions;
  }
  // Fallback: return NotModified
  console.warn('[REACTIONS] available_reactions.bin not found, returning NotModified');
  return buildAvailableReactionsNotModified();
}

// Cached captured binary files
const _binCache = new Map<string, Buffer>();

function loadCapturedBin(filename: string): Buffer | undefined {
  if (_binCache.has(filename)) return _binCache.get(filename);
  const binPath = resolvePath(__dirname, '../../data', filename);
  if (existsSync(binPath)) {
    const buf = readFileSync(binPath);
    _binCache.set(filename, buf);
    console.log(`[CAPTURE] Loaded ${filename}: ${buf.length} bytes`);
    return buf;
  }
  return undefined;
}

export function buildEmojiStickers(): Buffer {
  return loadCapturedBin('emoji_stickers.bin') ?? buildAllStickersEmpty();
}

export function buildFeaturedEmojiStickers(): Buffer {
  return loadCapturedBin('featured_emoji_stickers.bin') ?? buildFeaturedStickersNotModified();
}

export function buildStickerSetFromCapture(setId: string): Buffer | undefined {
  return loadCapturedBin(`sticker_sets/${setId}.bin`);
}

// Lazy-built map: shortName → setId
let _shortNameMap: Map<string, string> | undefined;
function getShortNameMap(): Map<string, string> {
  if (_shortNameMap) return _shortNameMap;
  _shortNameMap = new Map();
  const setsDir = resolvePath(__dirname, '../../data/sticker_sets');
  if (!existsSync(setsDir)) return _shortNameMap;
  const { readdirSync } = require('fs') as typeof import('fs');
  for (const f of readdirSync(setsDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(readFileSync(resolvePath(setsDir, f), 'utf-8'));
      const sn = d?.set?.shortName ?? d?.set?.short_name;
      if (sn) _shortNameMap.set(sn.toLowerCase(), f.replace('.json', ''));
    } catch {}
  }
  console.log(`[STICKERSET] Built shortName map: ${_shortNameMap.size} entries`);
  return _shortNameMap;
}

export function buildStickerSetFromCaptureByShortName(shortName: string): Buffer | undefined {
  const map = getShortNameMap();
  const setId = map.get(shortName.toLowerCase());
  if (!setId) return undefined;
  return loadCapturedBin(`sticker_sets/${setId}.bin`);
}

export function buildStickerSetFromCaptureByTypeName(typeName: string): Buffer | undefined {
  return loadCapturedBin(`sticker_sets/${typeName}.bin`);
}

export function buildSavedDialogsEmpty(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0xf83ae221);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  return w.getBytes();
}

export function buildSponsoredMessagesEmpty(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x1839490f);
  return w.getBytes();
}

// contacts.sponsoredPeersEmpty#ea32b4b1 = contacts.SponsoredPeers
export function buildSponsoredPeersEmpty(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0xea32b4b1);
  return w.getBytes();
}

// searchPostsFlood#3e0b5b6a flags:# query_is_free:flags.0?true total_daily:int remains:int
//   wait_till:flags.1?int stars_amount:long = SearchPostsFlood
export function buildSearchPostsFlood(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x3e0b5b6a);
  w.writeInt(1);       // flags: query_is_free (bit 0)
  w.writeInt(100);     // total_daily
  w.writeInt(100);     // remains
  // wait_till omitted (flags.1 not set)
  w.writeLong(0n);     // stars_amount
  return w.getBytes();
}

export function buildAllStoriesEmpty(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x6efc5e81);
  w.writeInt(0); w.writeInt(0);
  writeTlString(w, '');
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  // storiesStealthMode#712e27fd flags:#
  w.writeInt(0x712e27fd); w.writeInt(0);
  return w.getBytes();
}

export function buildTopReactions(): Buffer {
  // messages.reactions#eafdf716 hash:long reactions:Vector<Reaction>
  const emojis = ['👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩', '🤮', '💩', '🙏', '🤝', '🍾', '💔', '🤣', '❤‍🔥', '🍌', '🏆', '😭', '😘', '💯', '🤡', '🖕', '😍', '🌚', '🆒'];
  const w = new BinaryWriter();
  w.writeInt(0xeafdf716); // messages.reactions
  w.writeLong(1n); // hash
  w.writeInt(0x1cb5c415); // vector
  w.writeInt(emojis.length);
  for (const e of emojis) {
    w.writeInt(0x1b2286b8); // reactionEmoji
    writeTlString(w, e);
  }
  return w.getBytes();
}

export function buildRecentReactions(): Buffer {
  // messages.reactions#eafdf716 hash:long reactions:Vector<Reaction>
  const emojis = ['👍', '❤', '🔥', '👏', '😁', '🎉', '🤩', '😱'];
  const w = new BinaryWriter();
  w.writeInt(0xeafdf716); // messages.reactions
  w.writeLong(1n); // hash
  w.writeInt(0x1cb5c415); // vector
  w.writeInt(emojis.length);
  for (const e of emojis) {
    w.writeInt(0x1b2286b8); // reactionEmoji
    writeTlString(w, e);
  }
  return w.getBytes();
}

export function buildReactionsEmpty(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0xeafdf716);
  w.writeLong(0n);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  return w.getBytes();
}

export function buildGlobalPrivacySettings(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(isModernLayer() ? 0x734c4ccb : 0xfe41b34f);
  w.writeInt(0);
  return w.getBytes();
}

export function buildAttachMenuBotsNotModified(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0xf1d88a5c);
  return w.getBytes();
}

export function buildEmojiKeywordsDifference(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x5cc761bd);
  writeTlString(w, 'en');
  w.writeInt(0); w.writeInt(1);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  return w.getBytes();
}

export function buildEmojiURL(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0xa575739d);
  writeTlString(w, '');
  return w.getBytes();
}

export function buildReactionsNotModified(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0xb06fdbdf);
  return w.getBytes();
}

export function buildDefaultHistoryTTL(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x43b46b20);
  w.writeInt(0);
  return w.getBytes();
}

export function buildSavedReactionTagsEmpty(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x3259950a);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeLong(0n);
  return w.getBytes();
}

export function buildQuickRepliesEmpty(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0xc68d6695);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  return w.getBytes();
}

export function buildAvailableEffectsEmpty(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0xbddb616e);
  w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  return w.getBytes();
}

export function buildStarsStatusEmpty(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x6c9ce8ed);
  w.writeInt(0);
  // starsAmount#bbb6b4a3
  w.writeInt(0xbbb6b4a3); w.writeLong(0n); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  return w.getBytes();
}

export function buildEmojiStatusesEmpty(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x90c467d1);
  w.writeLong(0n);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  return w.getBytes();
}

export function buildStarGiftsEmpty(): Buffer {
  const w = new BinaryWriter();
  const modern = isModernLayer();
  w.writeInt(modern ? 0x901689ea : 0x2ed82995);
  w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0); // gifts
  if (!modern) {
    w.writeInt(0x1cb5c415); w.writeInt(0); // chats (web client schema)
    w.writeInt(0x1cb5c415); w.writeInt(0); // users (web client schema)
  }
  return w.getBytes();
}

export function buildSavedStarGiftsEmpty(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x95f389b1);
  w.writeInt(0); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  return w.getBytes();
}

export function buildStarGiftActiveAuctionsEmpty(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0xaef6abbc);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  return w.getBytes();
}

export function buildTimezonesListEmpty(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x7b74ed71);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0);
  return w.getBytes();
}

export function buildContentSettings(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x57e28221);
  w.writeInt(0);
  return w.getBytes();
}

export function buildPrivacyRulesEmpty(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x50a04e45);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  w.writeInt(0x1cb5c415); w.writeInt(0);
  return w.getBytes();
}

/**
 * Build account.PrivacyRules#50a04e45 with actual rules from DB.
 * rules: PrivacyRule[], chats: Chat[], users: User[]
 */
export function buildPrivacyRules(
  rules: Array<{ ruleType: string; value: number[] }>,
): Buffer {
  const w = new BinaryWriter();
  // account.privacyRules#50a04e45 rules:Vector<PrivacyRule> chats:Vector<Chat> users:Vector<User>
  w.writeInt(0x50a04e45);

  // --- rules vector ---
  w.writeInt(0x1cb5c415); // vector
  w.writeInt(rules.length);
  for (const rule of rules) {
    writePrivacyRule(w, rule.ruleType, rule.value);
  }

  // --- chats vector (empty) ---
  w.writeInt(0x1cb5c415);
  w.writeInt(0);

  // --- users vector (empty) ---
  w.writeInt(0x1cb5c415);
  w.writeInt(0);

  return w.getBytes();
}

function writePrivacyRule(w: BinaryWriter, ruleType: string, value: number[]): void {
  switch (ruleType) {
    case 'allowAll':
      w.writeInt(0x65427b82); // privacyValueAllowAll
      break;
    case 'disallowAll':
      w.writeInt(0x8b73e763); // privacyValueDisallowAll
      break;
    case 'allowContacts':
      w.writeInt(0xfffe1bac); // privacyValueAllowContacts
      break;
    case 'disallowContacts':
      w.writeInt(0xf888fa1a); // privacyValueDisallowContacts
      break;
    case 'allowCloseFriends':
      w.writeInt(0xf7e8d89b); // privacyValueAllowCloseFriends
      break;
    case 'allowPremium':
      w.writeInt(0xece9814b); // privacyValueAllowPremium
      break;
    case 'allowBots':
      w.writeInt(0x21461b5d); // privacyValueAllowBots
      break;
    case 'disallowBots':
      w.writeInt(0xf6a5f82f); // privacyValueDisallowBots
      break;
    case 'allowUsers':
      // privacyValueAllowUsers#b8905fb2 users:Vector<long>
      w.writeInt(0xb8905fb2);
      w.writeInt(0x1cb5c415);
      w.writeInt(value.length);
      for (const uid of value) w.writeLong(BigInt(uid));
      break;
    case 'disallowUsers':
      // privacyValueDisallowUsers#e4621141 users:Vector<long>
      w.writeInt(0xe4621141);
      w.writeInt(0x1cb5c415);
      w.writeInt(value.length);
      for (const uid of value) w.writeLong(BigInt(uid));
      break;
    case 'allowChatParticipants':
      // privacyValueAllowChatParticipants#6b134e8e chats:Vector<long>
      w.writeInt(0x6b134e8e);
      w.writeInt(0x1cb5c415);
      w.writeInt(value.length);
      for (const cid of value) w.writeLong(BigInt(cid));
      break;
    case 'disallowChatParticipants':
      // privacyValueDisallowChatParticipants#41c87565 chats:Vector<long>
      w.writeInt(0x41c87565);
      w.writeInt(0x1cb5c415);
      w.writeInt(value.length);
      for (const cid of value) w.writeLong(BigInt(cid));
      break;
    default:
      // fallback: allowAll
      w.writeInt(0x65427b82);
      break;
  }
}

/**
 * Build globalPrivacySettings with actual stored settings.
 */
export function buildGlobalPrivacySettingsFromDb(settings: Record<string, string>): Buffer {
  const w = new BinaryWriter();
  // globalPrivacySettings#734c4ccb (modern) / #fe41b34f (old)
  // flags:# archive_and_mute_new_noncontact_peers:flags.0?true keep_archived_unmuted:flags.1?true
  // keep_archived_folders:flags.2?true hide_read_marks:flags.3?true
  // new_noncontact_peers_require_premium:flags.4?true noncontact_peers_paid_stars:flags.5?long
  // disallowed_gifts:flags.6?DisallowedGiftsSettings display_gifts_button:flags.7?true
  const cid = isModernLayer() ? 0x734c4ccb : 0xfe41b34f;
  w.writeInt(cid);

  let flags = 0;
  if (settings.archive_and_mute === '1') flags |= (1 << 0);
  if (settings.keep_archived_unmuted === '1') flags |= (1 << 1);
  if (settings.keep_archived_folders === '1') flags |= (1 << 2);
  if (settings.hide_read_marks === '1') flags |= (1 << 3);
  if (settings.new_noncontact_peers_require_premium === '1') flags |= (1 << 4);
  // noncontact_peers_paid_stars (long, flags.5) — skip for now
  // disallowed_gifts (flags.6) — skip for now
  if (settings.display_gifts_button === '1') flags |= (1 << 7);

  w.writeInt(flags);
  // noncontact_peers_paid_stars would go here if flags.5 set

  return w.getBytes();
}

export function buildAccountPassword(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x957b50fb);
  w.writeInt(0);
  w.writeInt(0xd45ab096); // passwordKdfAlgoUnknown
  w.writeInt(0x004a8537); // securePasswordKdfAlgoUnknown
  writeTlBytes(w, Buffer.alloc(0));
  return w.getBytes();
}

export function buildAllStickersNotModified(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0xe86602c3);
  return w.getBytes();
}

export function buildAllStickersEmpty(): Buffer {
  // messages.allStickers#cdbbcebb hash:long sets:Vector<StickerSet>
  const w = new BinaryWriter();
  w.writeInt(0xcdbbcebb);
  w.writeLong(0n); // hash
  w.writeInt(0x1cb5c415); w.writeInt(0); // empty vector
  return w.getBytes();
}

export function buildFeaturedStickersNotModified(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0xc6dc0c66);
  w.writeInt(0);
  return w.getBytes();
}

export function buildRecentStickersNotModified(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x0b17f890);
  return w.getBytes();
}

export function buildSavedGifsNotModified(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0xe8025ca2);
  return w.getBytes();
}

export function buildFavedStickersNotModified(): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x9e8fa6d3);
  return w.getBytes();
}

export function buildAffectedMessages(pts: number, ptsCount: number): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x84d19185);
  w.writeInt(pts);
  w.writeInt(ptsCount);
  return w.getBytes();
}

// ========== Group / Channel builders ==========

/**
 * Build messages.invitedUsers#7f5defa6 response for messages.createChat
 * updates:Updates missing_invitees:Vector<MissingInvitee>
 *
 * Real Telegram sends 4 updates:
 * 1. UpdateMessageID — maps randomId to service message id
 * 2. UpdateChatParticipants — full participant list
 * 3. UpdateNewMessage — MessageService with MessageActionChatCreate
 * 4. UpdateReadHistoryOutbox — marks service msg as read
 */
export function buildInvitedUsers(
  chat: StoredChat,
  participants: StoredChatParticipant[],
  selfId: number,
  serviceMessage?: FixtureMessage,
  pts?: number,
  ptsCount?: number,
  randomId?: string,
): Buffer {
  const w = new BinaryWriter();
  // messages.invitedUsers#7f5defa6
  w.writeInt(0x7f5defa6);

  // updates: Updates (updates#74ae4240)
  w.writeInt(0x74ae4240);

  if (serviceMessage && pts !== undefined && ptsCount !== undefined && randomId) {
    // Real updates matching Telegram server behavior
    const updateBuffers: Buffer[] = [];
    // 1. UpdateMessageID
    updateBuffers.push(buildUpdateMessageID(serviceMessage.id, randomId));
    // 2. UpdateChatParticipants
    updateBuffers.push(buildUpdateChatParticipants(chat.id, participants, selfId));
    // 3. UpdateNewMessage with MessageService
    updateBuffers.push(buildUpdateNewMessage(serviceMessage, pts, ptsCount));
    // 4. UpdateReadHistoryOutbox
    const readPts = pts + 1;
    updateBuffers.push(buildUpdateReadHistoryOutbox(`chat:${chat.id}`, serviceMessage.id, readPts, 1));

    w.writeInt(0x1cb5c415);
    w.writeInt(updateBuffers.length);
    for (const buf of updateBuffers) {
      w.writeBytes(buf);
    }
  } else {
    // Fallback: empty updates vector
    writeEmptyVectorToWriter(w);
  }

  // users: Vector<User>
  const userIds = participants.map(p => p.userId);
  userIds.push(selfId);
  const uniqueUserIds = Array.from(new Set(userIds));
  w.writeInt(0x1cb5c415);
  w.writeInt(uniqueUserIds.length);
  for (const uid of uniqueUserIds) {
    const isSelf = uid === selfId;
    writeUserFromFixture(w, getFixtureUserForId(undefined, String(uid), isSelf), selfId);
  }

  // chats: Vector<Chat>
  w.writeInt(0x1cb5c415);
  w.writeInt(1);
  writeChatFromDb(w, chat, selfId);

  w.writeInt(Math.floor(Date.now() / 1000)); // date
  w.writeInt(0); // seq

  // missing_invitees: Vector<MissingInvitee>
  writeEmptyVectorToWriter(w);

  return w.getBytes();
}

/**
 * Build updateChatParticipants#07761198 participants:ChatParticipants
 */
export function buildUpdateChatParticipants(
  chatId: number,
  participants: StoredChatParticipant[],
  selfId: number,
): Buffer {
  const w = new BinaryWriter();
  // updateChatParticipants#07761198
  w.writeInt(0x07761198);
  // chatParticipants#3cbc93f8 chat_id:long participants:Vector<ChatParticipant> version:int
  w.writeInt(0x3cbc93f8);
  w.writeLong(BigInt(chatId));
  w.writeInt(0x1cb5c415); // vector
  w.writeInt(participants.length);
  for (const p of participants) {
    if (p.role === 'creator') {
      // chatParticipantCreator#e1f867b8 flags:# user_id:long rank:flags.0?string
      w.writeInt(0xe1f867b8);
      const pFlags = p.rank ? 1 : 0;
      w.writeInt(pFlags);
      w.writeLong(BigInt(p.userId));
      if (p.rank) writeTlString(w, p.rank);
    } else if (p.role === 'admin') {
      // chatParticipantAdmin#360d5d2 flags:# user_id:long inviter_id:long date:int rank:flags.0?string
      w.writeInt(0x360d5d2);
      const pFlags = p.rank ? 1 : 0;
      w.writeInt(pFlags);
      w.writeLong(BigInt(p.userId));
      w.writeLong(BigInt(p.inviterId || selfId));
      w.writeInt(p.date);
      if (p.rank) writeTlString(w, p.rank);
    } else {
      // chatParticipant#38e79fde flags:# user_id:long inviter_id:long date:int rank:flags.0?string
      w.writeInt(0x38e79fde);
      w.writeInt(0); // flags (no rank)
      w.writeLong(BigInt(p.userId));
      w.writeLong(BigInt(p.inviterId || selfId));
      w.writeInt(p.date);
    }
  }
  w.writeInt(1); // version
  return w.getBytes();
}

/**
 * Build Updates response for channels.createChannel
 *
 * Real Telegram sends 4 updates:
 * 1. UpdateMessageID — maps randomId to service message id
 * 2. UpdateChannel — channel notification
 * 3. UpdateReadChannelInbox — marks service msg as read
 * 4. UpdateNewChannelMessage — MessageService with MessageActionChannelCreate
 */
export function buildCreateChannelUpdates(
  chat: StoredChat,
  selfId: number,
  serviceMessage?: FixtureMessage,
  pts?: number,
  ptsCount?: number,
  randomId?: string,
): Buffer {
  const w = new BinaryWriter();
  // updates#74ae4240
  w.writeInt(0x74ae4240);

  if (serviceMessage && pts !== undefined && ptsCount !== undefined && randomId) {
    // Real updates matching Telegram server behavior
    const updateBuffers: Buffer[] = [];
    // 1. UpdateMessageID
    updateBuffers.push(buildUpdateMessageID(serviceMessage.id, randomId));
    // 2. UpdateChannel#635b4c09 channel_id:long
    updateBuffers.push(buildUpdateChannel(chat.id));
    // 3. UpdateReadChannelInbox#922e6e10
    updateBuffers.push(buildUpdateReadChannelInbox(chat.id, serviceMessage.id, pts + 1));
    // 4. UpdateNewChannelMessage#62ba04d9
    updateBuffers.push(buildUpdateNewChannelMessage(serviceMessage, pts, ptsCount));

    w.writeInt(0x1cb5c415);
    w.writeInt(updateBuffers.length);
    for (const buf of updateBuffers) {
      w.writeBytes(buf);
    }
  } else {
    // Fallback: empty updates vector
    writeEmptyVectorToWriter(w);
  }

  // users: Vector<User>
  w.writeInt(0x1cb5c415);
  w.writeInt(1);
  writeUserFromFixture(w, getFixtureUserForId(undefined, String(selfId), true), selfId);

  // chats: Vector<Chat>
  w.writeInt(0x1cb5c415);
  w.writeInt(1);
  writeChatFromDb(w, chat, selfId);

  w.writeInt(Math.floor(Date.now() / 1000)); // date
  w.writeInt(0); // seq

  return w.getBytes();
}

/** updateChannel#635b4c09 channel_id:long */
export function buildUpdateChannel(channelId: number): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x635b4c09);
  w.writeLong(BigInt(channelId));
  return w.getBytes();
}

/** updateReadChannelInbox#922e6e10 flags:# folder_id:flags.0?int channel_id:long max_id:int still_unread_count:int pts:int */
export function buildUpdateReadChannelInbox(channelId: number, maxId: number, pts: number): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x922e6e10);
  w.writeInt(0); // flags (no folder_id)
  w.writeLong(BigInt(channelId));
  w.writeInt(maxId);
  w.writeInt(0); // still_unread_count
  w.writeInt(pts);
  return w.getBytes();
}

/** updateNewChannelMessage#62ba04d9 message:Message pts:int pts_count:int */
export function buildUpdateNewChannelMessage(message: FixtureMessage, pts: number, ptsCount: number): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x62ba04d9);
  writeMessageFromFixture(w, message);
  w.writeInt(pts);
  w.writeInt(ptsCount);
  return w.getBytes();
}

/**
 * Build messages.chatFull#e5d7d19c for messages.getFullChat
 */
export function buildChatFull(chat: StoredChat, participants: StoredChatParticipant[], selfId: number): Buffer {
  const w = new BinaryWriter();
  // messages.chatFull#e5d7d19c full_chat:ChatFull chats:Vector<Chat> users:Vector<User>
  w.writeInt(0xe5d7d19c);

  // chatFull#2633421b flags:# can_set_username:flags.7? ... id:long about:string participants:ChatParticipants
  // chat_photo:flags.2?Photo notify_settings:PeerNotifySettings exported_invite:flags.13?ExportedChatInvite
  // bot_info:flags.3?Vector<BotInfo> pinned_msg_id:flags.6?int folder_id:flags.11?int
  w.writeInt(0x2633421b);
  let flags = (1 << 18); // available_reactions present
  w.writeInt(flags);
  w.writeLong(BigInt(chat.id));
  writeTlString(w, chat.about || '');

  // participants: ChatParticipants
  // chatParticipants#3cbc93f8 chat_id:long participants:Vector<ChatParticipant> version:int
  w.writeInt(0x3cbc93f8);
  w.writeLong(BigInt(chat.id));
  w.writeInt(0x1cb5c415); // vector
  w.writeInt(participants.length);
  for (const p of participants) {
    if (p.role === 'creator') {
      // chatParticipantCreator#e1f867b8 flags:# user_id:long rank:flags.0?string
      w.writeInt(0xe1f867b8);
      const pFlags = p.rank ? 1 : 0;
      w.writeInt(pFlags);
      w.writeLong(BigInt(p.userId));
      if (p.rank) writeTlString(w, p.rank);
    } else if (p.role === 'admin') {
      // chatParticipantAdmin#360d5d2 flags:# user_id:long inviter_id:long date:int rank:flags.0?string
      w.writeInt(0x360d5d2);
      const pFlags = p.rank ? 1 : 0;
      w.writeInt(pFlags);
      w.writeLong(BigInt(p.userId));
      w.writeLong(BigInt(p.inviterId || selfId));
      w.writeInt(p.date);
      if (p.rank) writeTlString(w, p.rank);
    } else {
      // chatParticipant#38e79fde flags:# user_id:long inviter_id:long date:int rank:flags.0?string
      w.writeInt(0x38e79fde);
      w.writeInt(0); // flags (no rank)
      w.writeLong(BigInt(p.userId));
      w.writeLong(BigInt(p.inviterId || selfId));
      w.writeInt(p.date);
    }
  }
  w.writeInt(1); // version

  // notify_settings: PeerNotifySettings
  writePeerNotifySettingsToWriter(w);

  // available_reactions: flags.18 → chatReactionsAll#52928bca flags:# allow_custom:flags.0?true
  w.writeInt(0x52928bca);
  w.writeInt(0); // flags (no allow_custom)

  // chats: Vector<Chat>
  w.writeInt(0x1cb5c415);
  w.writeInt(1);
  writeChatFromDb(w, chat, selfId);

  // users: Vector<User>
  const userIds = participants.map(p => p.userId);
  const uniqueUserIds = Array.from(new Set(userIds));
  w.writeInt(0x1cb5c415);
  w.writeInt(uniqueUserIds.length);
  for (const uid of uniqueUserIds) {
    writeUserFromFixture(w, getFixtureUserForId(undefined, String(uid), uid === selfId), selfId);
  }

  return w.getBytes();
}

/**
 * Build channels.channelParticipants#9ab0feaf
 */
export function buildChannelParticipants(participants: StoredChatParticipant[], selfId: number): Buffer {
  const w = new BinaryWriter();
  // channels.channelParticipants#9ab0feaf count:int participants:Vector<ChannelParticipant> chats:Vector<Chat> users:Vector<User>
  w.writeInt(0x9ab0feaf);
  w.writeInt(participants.length);

  // participants: Vector<ChannelParticipant>
  w.writeInt(0x1cb5c415);
  w.writeInt(participants.length);
  for (const p of participants) {
    if (p.role === 'creator') {
      // channelParticipantCreator#2fe601d3 flags:# user_id:long admin_rights:ChatAdminRights rank:flags.0?string
      w.writeInt(0x2fe601d3);
      const pFlags = p.rank ? 1 : 0;
      w.writeInt(pFlags);
      w.writeLong(BigInt(p.userId));
      // ChatAdminRights — all rights for creator
      w.writeInt(0x5fb224d5);
      w.writeInt(0x3FFFF); // all rights
      if (p.rank) writeTlString(w, p.rank);
    } else if (p.role === 'admin') {
      // channelParticipantAdmin#34c3bb53 flags:# can_edit:flags.0?true self:flags.1?true
      // user_id:long inviter_id:flags.1?long promoted_by:long date:int admin_rights:ChatAdminRights rank:flags.2?string
      w.writeInt(0x34c3bb53);
      let pFlags = (1 << 0); // can_edit
      if (p.userId === selfId) pFlags |= (1 << 1); // self
      if (p.rank) pFlags |= (1 << 2);
      w.writeInt(pFlags);
      w.writeLong(BigInt(p.userId));
      if (p.userId === selfId) {
        w.writeLong(BigInt(p.inviterId || selfId));
      }
      w.writeLong(BigInt(p.inviterId || selfId)); // promoted_by
      w.writeInt(p.date);
      // ChatAdminRights
      w.writeInt(0x5fb224d5);
      w.writeInt(0x3F); // basic rights
      if (p.rank) writeTlString(w, p.rank);
    } else {
      if (isModernLayer()) {
        // channelParticipant#c00c07c0 user_id:long date:int (GramJS npm)
        w.writeInt(0xc00c07c0);
        w.writeLong(BigInt(p.userId));
        w.writeInt(p.date);
      } else {
        // channelParticipant#1bd54456 flags:# user_id:long date:int subscription_until_date:flags.0?int rank:flags.2?string (web client)
        w.writeInt(0x1bd54456);
        w.writeInt(0); // flags — no subscription_until_date, no rank
        w.writeLong(BigInt(p.userId));
        w.writeInt(p.date);
      }
    }
  }

  // chats: Vector<Chat> - empty
  writeEmptyVectorToWriter(w);

  // users: Vector<User>
  const userIds = participants.map(p => p.userId);
  const uniqueUserIds = Array.from(new Set(userIds));
  w.writeInt(0x1cb5c415);
  w.writeInt(uniqueUserIds.length);
  for (const uid of uniqueUserIds) {
    writeUserFromFixture(w, getFixtureUserForId(undefined, String(uid), uid === selfId), selfId);
  }

  return w.getBytes();
}

/**
 * Build channels.channelParticipant#dfb80317 for a single participant
 * participant:ChannelParticipant chats:Vector<Chat> users:Vector<User>
 */
export function buildChannelParticipantSingle(participant: StoredChatParticipant, chat: StoredChat, selfId: number): Buffer {
  const w = new BinaryWriter();
  // channels.channelParticipant#dfb80317
  w.writeInt(0xdfb80317);

  const p = participant;
  if (p.role === 'creator') {
    // channelParticipantCreator#2fe601d3
    w.writeInt(0x2fe601d3);
    const creatorFlags = p.rank ? 1 : 0;
    w.writeInt(creatorFlags);
    w.writeLong(BigInt(p.userId));
    // ChatAdminRights — full rights
    w.writeInt(0x5fb224d5);
    w.writeInt(0x7FFFF); // all rights
    if (p.rank) writeTlString(w, p.rank);
  } else if (p.role === 'admin') {
    // channelParticipantAdmin#34c3bb53
    w.writeInt(0x34c3bb53);
    let adminFlags = 0;
    if (p.rank) adminFlags |= (1 << 2);
    w.writeInt(adminFlags);
    w.writeLong(BigInt(p.userId));
    w.writeLong(BigInt(p.inviterId || selfId)); // promoted_by
    w.writeInt(p.date);
    // ChatAdminRights
    w.writeInt(0x5fb224d5);
    w.writeInt(0x3F);
    if (p.rank) writeTlString(w, p.rank);
  } else {
    // channelParticipant#1bd54456 flags:# user_id:long date:int
    w.writeInt(0x1bd54456);
    const memberFlags = p.rank ? (1 << 2) : 0;
    w.writeInt(memberFlags);
    w.writeLong(BigInt(p.userId));
    w.writeInt(p.date);
    if (p.rank) writeTlString(w, p.rank);
  }

  // chats: Vector<Chat>
  w.writeInt(0x1cb5c415);
  w.writeInt(1);
  writeChatFromDb(w, chat, selfId);

  // users: Vector<User>
  const userIds = new Set([p.userId, selfId]);
  w.writeInt(0x1cb5c415);
  w.writeInt(userIds.size);
  for (const uid of userIds) {
    writeUserFromFixture(w, getFixtureUserForId(undefined, String(uid), uid === selfId), selfId);
  }

  return w.getBytes();
}

/**
 * Build a live updates envelope that includes chats
 */
export function buildLiveUpdatesEnvelopeWithChats(
  updateBuffers: Buffer[],
  userIds: string[],
  chatIds: number[],
  selfId: number,
  participantSelfId?: number,
): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x74ae4240);
  writeBufferVector(w, updateBuffers);

  // users — deduplicate and mark participantSelfId as self
  const allUserIds = Array.from(new Set([...userIds, ...(participantSelfId ? [String(participantSelfId)] : [])]));
  if (allUserIds.length > 0) {
    w.writeInt(0x1cb5c415);
    w.writeInt(allUserIds.length);
    for (const userId of allUserIds) {
      const isSelf = participantSelfId !== undefined && userId === String(participantSelfId);
      writeUserFromFixture(w, getFixtureUserForId(undefined, userId, isSelf), selfId);
    }
  } else {
    writeEmptyVectorToWriter(w);
  }

  // chats
  if (chatIds.length > 0) {
    w.writeInt(0x1cb5c415);
    w.writeInt(chatIds.length);
    for (const chatId of chatIds) {
      const chat = messageStore.getChatById(chatId);
      if (chat) {
        writeChatFromDb(w, chat, selfId);
      }
    }
  } else {
    writeEmptyVectorToWriter(w);
  }

  w.writeInt(Math.floor(Date.now() / 1000));
  w.writeInt(0);
  return w.getBytes();
}

export function buildRpcErrorObject(errorCode: number, errorMessage: string): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0x2144ca19);
  w.writeInt(errorCode);
  writeTlString(w, errorMessage);
  return w.getBytes();
}

export function buildRpcError(reqMsgId: bigint, errorCode: number, errorMessage: string): Buffer {
  const w = new BinaryWriter();
  w.writeInt(0xf35c6d01);
  w.writeLong(reqMsgId);
  w.writeInt(0x2144ca19);
  w.writeInt(errorCode);
  const msgBuf = Buffer.from(errorMessage);
  const msgHeader = Buffer.alloc(1);
  msgHeader[0] = msgBuf.length;
  const msgPad = Buffer.alloc((4 - ((1 + msgBuf.length) % 4)) % 4);
  w.writeBytes(Buffer.concat([msgHeader, msgBuf, msgPad]));
  return w.getBytes();
}
