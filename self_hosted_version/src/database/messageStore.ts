import { resolve } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import crypto from 'crypto';

import type BetterSqlite3 from 'better-sqlite3';

import { initDatabase } from './schema.js';

export interface StoredMessage {
  peerKey: string;
  messageId: number;
  clientRandomId?: string;
  date: number;
  text: string;
  isOutgoing: boolean;
  fromPeerKey?: string;
  post: boolean;
  editDate?: number;
  replyToMsgId?: number;
  quoteText?: string;
  quoteOffset?: number;
  mediaId?: number;
  fwdFromPeerKey?: string;
  fwdFromName?: string;
  fwdDate?: number;
  actionType?: string;
}

export interface StoredChat {
  id: number;
  type: 'group' | 'supergroup' | 'channel';
  title: string;
  about: string;
  creatorUserId: number;
  accessHash: bigint;
  date: number;
  participantsCount: number;
  isBroadcast: boolean;
  isMegagroup: boolean;
  photoId?: number;
}

export interface StoredChatParticipant {
  chatId: number;
  userId: number;
  role: 'creator' | 'admin' | 'member';
  inviterId?: number;
  date: number;
  rank?: string;
}

export interface StoredReaction {
  ownerUserId: number;
  peerKey: string;
  messageId: number;
  userId: number;
  emoticon: string;
  date: number;
}

export interface StoredDraft {
  ownerUserId: number;
  peerKey: string;
  text: string;
  date: number;
  replyToMsgId?: number;
}

export interface StoredPeerState {
  peerKey: string;
  readInboxMaxId: number;
  readOutboxMaxId: number;
  readInboxTs: number;
}

export interface StoredUpdateState {
  pts: number;
  qts: number;
  date: number;
  seq: number;
  unreadCount: number;
}

export interface StoredUser {
  id: number;
  phone: string;
  firstName: string;
  lastName: string;
  username?: string;
  accessHash: bigint;
  createdAt: number;
  photoId?: number;
  // Extended fields
  about?: string;
  bot?: boolean;
  botInfoVersion?: number;
  botInlinePlaceholder?: string;
  botActiveUsers?: number;
  verified?: boolean;
  restricted?: boolean;
  scam?: boolean;
  fake?: boolean;
  premium?: boolean;
  langCode?: string;
  emojiStatusDocumentId?: string;
  emojiStatusUntil?: number;
  colorId?: number;
  colorBackgroundEmojiId?: string;
  profileColorId?: number;
  profileColorBackgroundEmojiId?: string;
  birthdayDay?: number;
  birthdayMonth?: number;
  birthdayYear?: number;
  commonChatsCount?: number;
  pinnedMsgId?: number;
  phoneCallsAvailable?: boolean;
  phoneCallsPrivate?: boolean;
  videoCallsAvailable?: boolean;
  voiceMessagesForbidden?: boolean;
  privateForwardName?: string;
  ttlPeriod?: number;
  themeEmoticon?: string;
  contactRequirePremium?: boolean;
  personalChannelId?: number;
  personalChannelMessage?: number;
  stargiftsCount?: number;
}

export interface StoredAuthCode {
  phone: string;
  code: string;
  phoneCodeHash: string;
  expiresAt: number;
}

export interface StoredMedia {
  id: number;
  type: 'photo' | 'document';
  filePath: string;
  mimeType: string;
  fileSize: number;
  width?: number;
  height?: number;
  fileName?: string;
  duration?: number;
  waveform?: Buffer;
  isVoice?: boolean;
  createdAt: number;
}

export interface StoredUpdateEvent {
  pts: number;
  ptsCount: number;
  date: number;
  kind: 'new_message' | 'read_history' | 'read_history_outbox' | 'edit_message' | 'delete_messages' | 'reaction';
  peerKey: string;
  messageId?: number;
  maxId?: number;
}

type MessageRow = {
  peer_key: string;
  message_id: number;
  client_random_id: string | null;
  date: number;
  text: string;
  is_outgoing: number;
  from_peer_key: string | null;
  post: number;
  edit_date: number | null;
  reply_to_msg_id: number | null;
  quote_text: string | null;
  quote_offset: number | null;
  media_id: number | null;
  fwd_from_peer_key: string | null;
  fwd_from_name: string | null;
  fwd_date: number | null;
  action_type: string | null;
};

type UpdateStateRow = {
  pts: number;
  qts: number;
  date: number;
  seq: number;
  unread_count: number;
};

type UpdateEventRow = {
  pts: number;
  pts_count: number;
  date: number;
  kind: string;
  peer_key: string;
  message_id: number | null;
  max_id: number | null;
};

class MessageStore {
  private db: BetterSqlite3.Database;

  constructor(dbPath = resolve(process.cwd(), 'data', 'self_hosted.sqlite')) {
    this.db = initDatabase(dbPath);
    this.initSchema();
    this.reconcileUpdateState();
  }

  listMessages(ownerUserId: number, peerKey: string, limit?: number): StoredMessage[] {
    const query = limit
      ? this.db.prepare(`
          SELECT peer_key, message_id, client_random_id, date, text, is_outgoing, from_peer_key, post, edit_date, reply_to_msg_id, quote_text, quote_offset, media_id, fwd_from_peer_key, fwd_from_name, fwd_date, action_type
          FROM app_messages
          WHERE owner_user_id = ? AND peer_key = ?
          ORDER BY message_id DESC
          LIMIT ?
        `)
      : this.db.prepare(`
          SELECT peer_key, message_id, client_random_id, date, text, is_outgoing, from_peer_key, post, edit_date, reply_to_msg_id, quote_text, quote_offset, media_id, fwd_from_peer_key, fwd_from_name, fwd_date, action_type
          FROM app_messages
          WHERE owner_user_id = ? AND peer_key = ?
          ORDER BY message_id DESC
        `);

    const rows = limit
      ? query.all(ownerUserId, peerKey, limit) as MessageRow[]
      : query.all(ownerUserId, peerKey) as MessageRow[];

    return rows.map(mapMessageRow);
  }

  findByRandomId(ownerUserId: number, peerKey: string, randomId: string) {
    const row = this.db.prepare(`
      SELECT peer_key, message_id, client_random_id, date, text, is_outgoing, from_peer_key, post, edit_date, reply_to_msg_id, quote_text, quote_offset, media_id, fwd_from_peer_key, fwd_from_name, fwd_date, action_type
      FROM app_messages
      WHERE owner_user_id = ? AND peer_key = ? AND client_random_id = ?
    `).get(ownerUserId, peerKey, randomId) as MessageRow | undefined;

    return row ? mapMessageRow(row) : undefined;
  }

  listPeerKeys(ownerUserId: number): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT peer_key FROM app_messages WHERE owner_user_id = ?
    `).all(ownerUserId) as { peer_key: string }[];
    return rows.map((row) => row.peer_key);
  }

  getMessageForUser(messageId: number, userId: number): StoredMessage | undefined {
    const row = this.db.prepare(`
      SELECT peer_key, message_id, client_random_id, date, text, is_outgoing, from_peer_key, post, edit_date, reply_to_msg_id, quote_text, quote_offset, media_id, fwd_from_peer_key, fwd_from_name, fwd_date, action_type
      FROM app_messages
      WHERE owner_user_id = ? AND message_id = ?
      LIMIT 1
    `).get(userId, messageId) as MessageRow | undefined;
    return row ? mapMessageRow(row) : undefined;
  }

  getMessage(ownerUserId: number, peerKey: string, messageId: number) {
    const row = this.db.prepare(`
      SELECT peer_key, message_id, client_random_id, date, text, is_outgoing, from_peer_key, post, edit_date, reply_to_msg_id, quote_text, quote_offset, media_id, fwd_from_peer_key, fwd_from_name, fwd_date, action_type
      FROM app_messages
      WHERE owner_user_id = ? AND peer_key = ? AND message_id = ?
    `).get(ownerUserId, peerKey, messageId) as MessageRow | undefined;

    return row ? mapMessageRow(row) : undefined;
  }

  getUnreadCount(ownerUserId: number, peerKey: string): number {
    const state = this.getPeerState(ownerUserId, peerKey);
    const readInboxMaxId = state?.readInboxMaxId || 0;
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt
      FROM app_messages
      WHERE owner_user_id = ? AND peer_key = ? AND is_outgoing = 0 AND message_id > ?
    `).get(ownerUserId, peerKey, readInboxMaxId) as { cnt: number };
    return row.cnt;
  }

  getPeerState(ownerUserId: number, peerKey: string): StoredPeerState | undefined {
    const row = this.db.prepare(`
      SELECT peer_key, read_inbox_max_id, read_outbox_max_id, read_inbox_ts
      FROM app_peer_state
      WHERE owner_user_id = ? AND peer_key = ?
    `).get(ownerUserId, peerKey) as {
      peer_key: string;
      read_inbox_max_id: number;
      read_outbox_max_id: number;
      read_inbox_ts: number;
    } | undefined;

    if (!row) {
      return undefined;
    }

    return {
      peerKey: row.peer_key,
      readInboxMaxId: row.read_inbox_max_id,
      readOutboxMaxId: row.read_outbox_max_id,
      readInboxTs: row.read_inbox_ts || 0,
    };
  }

  getUpdateState(ownerUserId?: number): StoredUpdateState {
    const userId = ownerUserId ?? 0;
    const row = this.db.prepare(`
      SELECT pts, qts, date, seq, unread_count
      FROM app_updates_state
      WHERE owner_user_id = ?
    `).get(userId) as UpdateStateRow | undefined;

    if (!row) {
      const now = Math.floor(Date.now() / 1000);
      this.db.prepare(`
        INSERT INTO app_updates_state (
          owner_user_id,
          pts,
          qts,
          date,
          seq,
          unread_count,
          updated_at
        ) VALUES (?, 1, 0, ?, 0, 0, ?)
      `).run(userId, now, now);

      return {
        pts: 1,
        qts: 0,
        date: now,
        seq: 0,
        unreadCount: 0,
      };
    }

    return mapUpdateStateRow(row);
  }

  listUpdateEventsAfter(ownerUserId: number, pts: number, limit = 100): StoredUpdateEvent[] {
    const rows = this.db.prepare(`
      SELECT pts, pts_count, date, kind, peer_key, message_id, max_id
      FROM app_updates_log
      WHERE owner_user_id = ? AND pts > ?
      ORDER BY pts ASC
      LIMIT ?
    `).all(ownerUserId, pts, limit) as UpdateEventRow[];

    return rows.map(mapUpdateEventRow);
  }

  markHistoryRead(ownerUserId: number, peerKey: string, maxId: number) {
    const current = this.getPeerState(ownerUserId, peerKey);
    const nextReadInboxMaxId = Math.max(current?.readInboxMaxId || 0, maxId);
    const nextReadOutboxMaxId = current?.readOutboxMaxId || 0;
    const didAdvance = nextReadInboxMaxId > (current?.readInboxMaxId || 0);

    this.upsertPeerState(ownerUserId, peerKey, nextReadInboxMaxId, nextReadOutboxMaxId);
    const updateInfo = didAdvance
      ? this.appendUpdateEvent(ownerUserId, {
          kind: 'read_history',
          peerKey,
          maxId: nextReadInboxMaxId,
        })
      : {
          ...this.getUpdateState(ownerUserId),
          ptsCount: 0,
        };

    return {
      peerKey,
      readInboxMaxId: nextReadInboxMaxId,
      readOutboxMaxId: nextReadOutboxMaxId,
      updatePts: updateInfo.pts,
      updatePtsCount: updateInfo.ptsCount,
      updateDate: updateInfo.date,
    };
  }

  appendUpdateEvent_ReadHistory(ownerUserId: number, peerKey: string, maxId: number): { pts: number; ptsCount: number } {
    const current = this.getPeerState(ownerUserId, peerKey);
    const nextReadInboxMaxId = Math.max(current?.readInboxMaxId || 0, maxId);
    this.upsertPeerState(ownerUserId, peerKey, nextReadInboxMaxId, current?.readOutboxMaxId || 0);
    const info = this.appendUpdateEvent(ownerUserId, {
      kind: 'read_history',
      peerKey,
      maxId: nextReadInboxMaxId,
    });
    return { pts: info.pts, ptsCount: info.ptsCount };
  }

  appendUpdateEvent_ReadHistoryOutbox(ownerUserId: number, peerKey: string, maxId: number): { pts: number; ptsCount: number } {
    const current = this.getPeerState(ownerUserId, peerKey);
    const nextReadOutboxMaxId = Math.max(current?.readOutboxMaxId || 0, maxId);
    this.upsertPeerState(ownerUserId, peerKey, current?.readInboxMaxId || 0, nextReadOutboxMaxId);
    const info = this.appendUpdateEvent(ownerUserId, {
      kind: 'read_history_outbox',
      peerKey,
      maxId: nextReadOutboxMaxId,
    });
    return { pts: info.pts, ptsCount: info.ptsCount };
  }

  appendOutgoingMessage(ownerUserId: number, input: {
    peerKey: string;
    text: string;
    clientRandomId: string;
    seedMaxMessageId: number;
    fromPeerKey?: string;
    post?: boolean;
    replyToMsgId?: number;
    quoteText?: string;
    quoteOffset?: number;
    mediaId?: number;
    fwdFromPeerKey?: string;
    fwdFromName?: string;
    fwdDate?: number;
    actionType?: string;
  }): StoredMessage & { updatePts: number; updatePtsCount: number; updateDate: number } {
    const existing = this.findByRandomId(ownerUserId, input.peerKey, input.clientRandomId);
    if (existing) {
      const state = this.getUpdateState(ownerUserId);
      return {
        ...existing,
        updatePts: state.pts,
        updatePtsCount: 0,
        updateDate: state.date,
      };
    }

    const nextMessageId = this.reserveMessageId(ownerUserId, input.peerKey, input.seedMaxMessageId + 1);
    const date = Math.floor(Date.now() / 1000);

    this.db.prepare(`
      INSERT INTO app_messages (
        owner_user_id,
        peer_key,
        message_id,
        client_random_id,
        date,
        text,
        is_outgoing,
        from_peer_key,
        post,
        created_at,
        reply_to_msg_id,
        quote_text,
        quote_offset,
        media_id,
        fwd_from_peer_key,
        fwd_from_name,
        fwd_date,
        action_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ownerUserId,
      input.peerKey,
      nextMessageId,
      input.clientRandomId,
      date,
      input.text,
      1,
      input.fromPeerKey || null,
      input.post ? 1 : 0,
      date,
      input.replyToMsgId || null,
      input.quoteText || null,
      input.quoteOffset ?? null,
      input.mediaId || null,
      input.fwdFromPeerKey || null,
      input.fwdFromName || null,
      input.fwdDate || null,
      input.actionType || null,
    );

    const currentState = this.getPeerState(ownerUserId, input.peerKey);
    this.upsertPeerState(
      ownerUserId,
      input.peerKey,
      currentState?.readInboxMaxId || 0,
      Math.max(currentState?.readOutboxMaxId || 0, nextMessageId),
    );
    const updateInfo = this.appendUpdateEvent(ownerUserId, {
      kind: 'new_message',
      peerKey: input.peerKey,
      messageId: nextMessageId,
    });

    return {
      peerKey: input.peerKey,
      messageId: nextMessageId,
      clientRandomId: input.clientRandomId,
      date,
      text: input.text,
      isOutgoing: true,
      fromPeerKey: input.fromPeerKey,
      post: Boolean(input.post),
      replyToMsgId: input.replyToMsgId,
      quoteText: input.quoteText,
      quoteOffset: input.quoteOffset,
      mediaId: input.mediaId,
      fwdFromPeerKey: input.fwdFromPeerKey,
      fwdFromName: input.fwdFromName,
      fwdDate: input.fwdDate,
      actionType: input.actionType,
      updatePts: updateInfo.pts,
      updatePtsCount: updateInfo.ptsCount,
      updateDate: updateInfo.date,
    };
  }

  markMessageIncoming(ownerUserId: number, peerKey: string, messageId: number): void {
    this.db.prepare(`UPDATE app_messages SET is_outgoing = 0 WHERE owner_user_id = ? AND peer_key = ? AND message_id = ?`).run(ownerUserId, peerKey, messageId);
  }

  editMessage(ownerUserId: number, peerKey: string, messageId: number, newText: string): { message: StoredMessage; updatePts: number; updatePtsCount: number } | undefined {
    const editDate = Math.floor(Date.now() / 1000);
    const result = this.db.prepare(`
      UPDATE app_messages SET text = ?, edit_date = ? WHERE owner_user_id = ? AND peer_key = ? AND message_id = ?
    `).run(newText, editDate, ownerUserId, peerKey, messageId);
    if (result.changes === 0) return undefined;

    const message = this.getMessage(ownerUserId, peerKey, messageId);
    if (!message) return undefined;

    const event = this.appendUpdateEvent(ownerUserId, { kind: 'edit_message', peerKey, messageId });
    return { message, updatePts: event.pts, updatePtsCount: event.ptsCount };
  }

  deleteMessages(ownerUserId: number, peerKey: string, messageIds: number[]): { updatePts: number; updatePtsCount: number } | undefined {
    const placeholders = messageIds.map(() => '?').join(',');
    const result = this.db.prepare(`
      DELETE FROM app_messages WHERE owner_user_id = ? AND peer_key = ? AND message_id IN (${placeholders})
    `).run(ownerUserId, peerKey, ...messageIds);
    if (result.changes === 0) return undefined;

    let lastEvent: { pts: number; ptsCount: number } = { pts: 0, ptsCount: 0 };
    for (const messageId of messageIds) {
      lastEvent = this.appendUpdateEvent(ownerUserId, { kind: 'delete_messages', peerKey, messageId });
    }
    return { updatePts: lastEvent.pts, updatePtsCount: messageIds.length };
  }

  findMessageInAllPeers(ownerUserId: number, messageId: number): StoredMessage | undefined {
    const row = this.db.prepare(`
      SELECT peer_key, message_id, client_random_id, date, text, is_outgoing, from_peer_key, post, edit_date, reply_to_msg_id, quote_text, quote_offset, media_id, fwd_from_peer_key, fwd_from_name, fwd_date, action_type
      FROM app_messages WHERE owner_user_id = ? AND message_id = ? LIMIT 1
    `).get(ownerUserId, messageId) as MessageRow | undefined;
    return row ? mapMessageRow(row) : undefined;
  }

  /**
   * Resolve sender's messageIds to the corresponding messageIds in the recipient's store.
   * Uses clientRandomId mapping: sender has "X", recipient has "recv_X".
   */
  resolveRecipientMessageIds(
    senderUserId: number,
    senderPeerKey: string,
    recipientUserId: number,
    recipientPeerKey: string,
    senderMessageIds: number[],
  ): number[] {
    const recipientIds: number[] = [];
    for (const msgId of senderMessageIds) {
      const senderMsg = this.getMessage(senderUserId, senderPeerKey, msgId);
      if (!senderMsg?.clientRandomId) continue;
      const recipientRandomId = senderMsg.clientRandomId.startsWith('recv_')
        ? senderMsg.clientRandomId.slice(5)
        : `recv_${senderMsg.clientRandomId}`;
      const recipientMsg = this.findByRandomId(recipientUserId, recipientPeerKey, recipientRandomId);
      if (recipientMsg) recipientIds.push(recipientMsg.messageId);
    }
    return recipientIds;
  }

  saveAuthKey(keyIdHex: string, authKey: Buffer): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      INSERT INTO auth_keys (key_id_hex, auth_key, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key_id_hex) DO NOTHING
    `).run(keyIdHex, authKey, now);
  }

  loadAllAuthKeys(): Array<{ keyIdHex: string; authKey: Buffer; userId?: number }> {
    const rows = this.db.prepare(`
      SELECT key_id_hex, auth_key, user_id FROM auth_keys
    `).all() as Array<{ key_id_hex: string; auth_key: Buffer; user_id: number | null }>;

    return rows.map((row) => ({
      keyIdHex: row.key_id_hex,
      authKey: Buffer.from(row.auth_key),
      userId: row.user_id || undefined,
    }));
  }

  bindAuthKeyToUser(keyIdHex: string, userId: number): void {
    this.db.prepare(`
      UPDATE auth_keys SET user_id = ? WHERE key_id_hex = ?
    `).run(userId, keyIdHex);
  }

  getUserIdForAuthKey(keyIdHex: string): number | undefined {
    const row = this.db.prepare(`
      SELECT user_id FROM auth_keys WHERE key_id_hex = ?
    `).get(keyIdHex) as { user_id: number | null } | undefined;
    return row?.user_id || undefined;
  }

  // ========== USER MANAGEMENT ==========

  private getNextUserId(): number {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(id), 99999) AS max_id FROM users
    `).get() as { max_id: number };
    return row.max_id + 1;
  }

  createUser(phone: string, firstName: string, lastName: string): StoredUser {
    const id = this.getNextUserId();
    const accessHash = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      INSERT INTO users (id, phone, first_name, last_name, access_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, phone, firstName, lastName, accessHash.toString(), now);
    return { id, phone, firstName, lastName, accessHash, createdAt: now };
  }

  private static readonly USER_COLUMNS = `id, phone, first_name, last_name, username, access_hash, created_at, photo_id, about, is_bot, bot_info_version, bot_inline_placeholder, bot_active_users, verified, restricted, scam, fake, premium, lang_code, emoji_status_document_id, emoji_status_until, color_id, color_background_emoji_id, profile_color_id, profile_color_background_emoji_id, birthday_day, birthday_month, birthday_year, common_chats_count, pinned_msg_id, phone_calls_available, phone_calls_private, video_calls_available, voice_messages_forbidden, private_forward_name, ttl_period, theme_emoticon, contact_require_premium, personal_channel_id, personal_channel_message, stargifts_count`;

  private mapUserRow(row: any): StoredUser {
    return {
      id: row.id,
      phone: row.phone,
      firstName: row.first_name,
      lastName: row.last_name,
      username: row.username || undefined,
      accessHash: BigInt(row.access_hash),
      createdAt: row.created_at,
      photoId: row.photo_id || undefined,
      about: row.about || undefined,
      bot: !!row.is_bot,
      botInfoVersion: row.bot_info_version || undefined,
      botInlinePlaceholder: row.bot_inline_placeholder || undefined,
      botActiveUsers: row.bot_active_users || undefined,
      verified: !!row.verified,
      restricted: !!row.restricted,
      scam: !!row.scam,
      fake: !!row.fake,
      premium: !!row.premium,
      langCode: row.lang_code || undefined,
      emojiStatusDocumentId: row.emoji_status_document_id || undefined,
      emojiStatusUntil: row.emoji_status_until || undefined,
      colorId: row.color_id ?? undefined,
      colorBackgroundEmojiId: row.color_background_emoji_id || undefined,
      profileColorId: row.profile_color_id ?? undefined,
      profileColorBackgroundEmojiId: row.profile_color_background_emoji_id || undefined,
      birthdayDay: row.birthday_day || undefined,
      birthdayMonth: row.birthday_month || undefined,
      birthdayYear: row.birthday_year || undefined,
      commonChatsCount: row.common_chats_count || undefined,
      pinnedMsgId: row.pinned_msg_id || undefined,
      phoneCallsAvailable: !!row.phone_calls_available,
      phoneCallsPrivate: !!row.phone_calls_private,
      videoCallsAvailable: !!row.video_calls_available,
      voiceMessagesForbidden: !!row.voice_messages_forbidden,
      privateForwardName: row.private_forward_name || undefined,
      ttlPeriod: row.ttl_period || undefined,
      themeEmoticon: row.theme_emoticon || undefined,
      contactRequirePremium: !!row.contact_require_premium,
      personalChannelId: row.personal_channel_id || undefined,
      personalChannelMessage: row.personal_channel_message || undefined,
      stargiftsCount: row.stargifts_count || undefined,
    };
  }

  getUserByPhone(phone: string): StoredUser | undefined {
    const row = this.db.prepare(`SELECT ${MessageStore.USER_COLUMNS} FROM users WHERE phone = ?`).get(phone) as any;
    if (!row) return undefined;
    return this.mapUserRow(row);
  }

  getUserByUsername(username: string): StoredUser | undefined {
    const row = this.db.prepare(`SELECT ${MessageStore.USER_COLUMNS} FROM users WHERE username = ? COLLATE NOCASE`).get(username) as any;
    if (!row) return undefined;
    return this.mapUserRow(row);
  }

  getUserById(id: number): StoredUser | undefined {
    const row = this.db.prepare(`SELECT ${MessageStore.USER_COLUMNS} FROM users WHERE id = ?`).get(id) as any;
    if (!row) return undefined;
    return this.mapUserRow(row);
  }

  updateUser(id: number, fields: Partial<{
    firstName: string; lastName: string; username: string; photoId: number | null;
    about: string | null; bot: boolean; botInfoVersion: number | null; botInlinePlaceholder: string | null; botActiveUsers: number | null;
    verified: boolean; restricted: boolean; scam: boolean; fake: boolean; premium: boolean;
    langCode: string | null;
    emojiStatusDocumentId: string | null; emojiStatusUntil: number | null;
    colorId: number | null; colorBackgroundEmojiId: string | null;
    profileColorId: number | null; profileColorBackgroundEmojiId: string | null;
    birthdayDay: number | null; birthdayMonth: number | null; birthdayYear: number | null;
    commonChatsCount: number; pinnedMsgId: number | null;
    phoneCallsAvailable: boolean; phoneCallsPrivate: boolean; videoCallsAvailable: boolean; voiceMessagesForbidden: boolean;
    privateForwardName: string | null; ttlPeriod: number | null; themeEmoticon: string | null;
    contactRequirePremium: boolean;
    personalChannelId: number | null; personalChannelMessage: number | null; stargiftsCount: number | null;
  }>): void {
    const sets: string[] = [];
    const params: any[] = [];
    const str = (col: string, val: string | null | undefined) => { if (val !== undefined) { sets.push(`${col} = ?`); params.push(val); } };
    const num = (col: string, val: number | null | undefined) => { if (val !== undefined) { sets.push(`${col} = ?`); params.push(val); } };
    const bool = (col: string, val: boolean | undefined) => { if (val !== undefined) { sets.push(`${col} = ?`); params.push(val ? 1 : 0); } };
    str('first_name', fields.firstName); str('last_name', fields.lastName);
    str('username', fields.username !== undefined ? (fields.username || null) : undefined);
    num('photo_id', fields.photoId); str('about', fields.about);
    bool('is_bot', fields.bot); num('bot_info_version', fields.botInfoVersion);
    str('bot_inline_placeholder', fields.botInlinePlaceholder); num('bot_active_users', fields.botActiveUsers);
    bool('verified', fields.verified); bool('restricted', fields.restricted);
    bool('scam', fields.scam); bool('fake', fields.fake); bool('premium', fields.premium);
    str('lang_code', fields.langCode);
    str('emoji_status_document_id', fields.emojiStatusDocumentId); num('emoji_status_until', fields.emojiStatusUntil);
    num('color_id', fields.colorId); str('color_background_emoji_id', fields.colorBackgroundEmojiId);
    num('profile_color_id', fields.profileColorId); str('profile_color_background_emoji_id', fields.profileColorBackgroundEmojiId);
    num('birthday_day', fields.birthdayDay); num('birthday_month', fields.birthdayMonth); num('birthday_year', fields.birthdayYear);
    num('common_chats_count', fields.commonChatsCount); num('pinned_msg_id', fields.pinnedMsgId);
    bool('phone_calls_available', fields.phoneCallsAvailable); bool('phone_calls_private', fields.phoneCallsPrivate);
    bool('video_calls_available', fields.videoCallsAvailable); bool('voice_messages_forbidden', fields.voiceMessagesForbidden);
    str('private_forward_name', fields.privateForwardName); num('ttl_period', fields.ttlPeriod);
    str('theme_emoticon', fields.themeEmoticon); bool('contact_require_premium', fields.contactRequirePremium);
    num('personal_channel_id', fields.personalChannelId); num('personal_channel_message', fields.personalChannelMessage);
    num('stargifts_count', fields.stargiftsCount);
    if (sets.length === 0) return;
    params.push(id);
    this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  searchUsers(query: string, excludeUserId?: number): StoredUser[] {
    const like = `%${query}%`;
    const sql = excludeUserId
      ? `SELECT ${MessageStore.USER_COLUMNS} FROM users
         WHERE (first_name LIKE ? OR last_name LIKE ? OR phone LIKE ? OR username LIKE ?) AND id != ? LIMIT 20`
      : `SELECT ${MessageStore.USER_COLUMNS} FROM users
         WHERE (first_name LIKE ? OR last_name LIKE ? OR phone LIKE ? OR username LIKE ?) LIMIT 20`;
    const rows = (excludeUserId
      ? this.db.prepare(sql).all(like, like, like, like, excludeUserId)
      : this.db.prepare(sql).all(like, like, like, like)
    ) as any[];
    return rows.map(row => this.mapUserRow(row));
  }

  getAllUsers(excludeUserId?: number): StoredUser[] {
    const sql = excludeUserId
      ? `SELECT ${MessageStore.USER_COLUMNS} FROM users WHERE id != ?`
      : `SELECT ${MessageStore.USER_COLUMNS} FROM users`;
    const rows = (excludeUserId
      ? this.db.prepare(sql).all(excludeUserId)
      : this.db.prepare(sql).all()
    ) as any[];
    return rows.map(row => this.mapUserRow(row));
  }

  /** Get distinct peer keys that have stored messages for a user */
  getActivePeerKeys(ownerUserId: number): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT peer_key FROM app_messages WHERE owner_user_id = ?`).all(ownerUserId) as { peer_key: string }[];
    return rows.map(r => r.peer_key);
  }

  /** Get last message for a peer key owned by a user */
  getLastMessage(ownerUserId: number, peerKey: string): StoredMessage | undefined {
    const row = this.db.prepare(`
      SELECT peer_key, message_id, client_random_id, date, text, is_outgoing, from_peer_key, post, edit_date, reply_to_msg_id, quote_text, quote_offset, media_id, fwd_from_peer_key, fwd_from_name, fwd_date, action_type
      FROM app_messages WHERE owner_user_id = ? AND peer_key = ? ORDER BY message_id DESC LIMIT 1
    `).get(ownerUserId, peerKey) as MessageRow | undefined;
    return row ? mapMessageRow(row) : undefined;
  }

  /** Get dialog peer keys for a user — simply all distinct peer_keys owned by this user */
  getDialogPeerKeysForUser(userId: number): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT peer_key FROM app_messages WHERE owner_user_id = ?
    `).all(userId) as { peer_key: string }[];
    return rows.map(r => r.peer_key);
  }

  /** Alias for getLastMessage (owner scoping handles everything) */
  getLastMessageForUser(peerKey: string, userId: number): StoredMessage | undefined {
    return this.getLastMessage(userId, peerKey);
  }

  /** Alias for listMessages (owner scoping handles everything) */
  listMessagesForUser(peerKey: string, userId: number, limit?: number): StoredMessage[] {
    return this.listMessages(userId, peerKey, limit);
  }

  /** Full-text search using FTS5 index */
  searchMessages(ownerUserId: number, query: string, options?: {
    peerKey?: string;
    offsetId?: number;
    limit?: number;
    hasMedia?: boolean;
    peerPrefix?: string; // e.g. 'user:' for private chats only
    actionType?: string; // e.g. 'chat_edit_photo' for chat photo filter
  }): StoredMessage[] {
    const limit = options?.limit || 20;
    const offsetId = options?.offsetId || 0;

    // If query is empty and no media filter and no actionType filter, return empty
    if (!query.trim() && !options?.hasMedia && !options?.actionType) {
      return [];
    }

    let sql: string;
    const params: (string | number)[] = [];

    if (query.trim()) {
      // FTS5 search — join via rowid; use prefix matching (word*) for substring-like behavior
      const ftsQuery = query.trim().split(/\s+/).map(w => `"${w.replace(/"/g, '""')}"*`).join(' ');
      sql = `
        SELECT m.peer_key, m.message_id, m.client_random_id, m.date, m.text,
               m.is_outgoing, m.from_peer_key, m.post, m.edit_date,
               m.reply_to_msg_id, m.quote_text, m.quote_offset, m.media_id, m.fwd_from_peer_key, m.fwd_from_name, m.fwd_date, m.action_type
        FROM app_messages m
        JOIN app_messages_fts fts ON fts.rowid = m.rowid
        WHERE m.owner_user_id = ?
          AND app_messages_fts MATCH ?
      `;
      params.push(ownerUserId, ftsQuery);
    } else {
      // No text query — filter by other criteria only
      sql = `
        SELECT peer_key, message_id, client_random_id, date, text,
               is_outgoing, from_peer_key, post, edit_date,
               reply_to_msg_id, quote_text, quote_offset, media_id, fwd_from_peer_key, fwd_from_name, fwd_date, action_type
        FROM app_messages m
        WHERE m.owner_user_id = ?
      `;
      params.push(ownerUserId);
    }

    if (options?.peerKey) {
      sql += ` AND m.peer_key = ?`;
      params.push(options.peerKey);
    }

    if (options?.peerPrefix) {
      sql += ` AND m.peer_key LIKE ?`;
      params.push(options.peerPrefix + '%');
    }

    if (options?.hasMedia) {
      sql += ` AND m.media_id IS NOT NULL`;
    }

    if (options?.actionType) {
      sql += ` AND m.action_type = ?`;
      params.push(options.actionType);
    }

    if (offsetId > 0) {
      sql += ` AND m.message_id < ?`;
      params.push(offsetId);
    }

    sql += ` ORDER BY m.date DESC, m.message_id DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as MessageRow[];
    return rows.map(mapMessageRow);
  }

  // ========== AUTH CODES ==========

  generateAuthCode(phone: string): StoredAuthCode {
    const code = String(Math.floor(10000 + Math.random() * 90000)); // 5-digit code
    const phoneCodeHash = Buffer.from(crypto.randomUUID().replace(/-/g, ''), 'hex').toString('base64url').slice(0, 16);
    const expiresAt = Math.floor(Date.now() / 1000) + 300; // 5 minutes
    this.db.prepare(`
      INSERT INTO auth_codes (phone, code, phone_code_hash, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET code = ?, phone_code_hash = ?, expires_at = ?
    `).run(phone, code, phoneCodeHash, expiresAt, code, phoneCodeHash, expiresAt);
    return { phone, code, phoneCodeHash, expiresAt };
  }

  // ========== File upload storage (in-memory) ==========
  private fileParts: Map<string, Map<number, Buffer>> = new Map();
  private assembledFiles: Map<string, Buffer> = new Map();

  saveFilePart(fileId: string, partNum: number, data: Buffer): void {
    if (!this.fileParts.has(fileId)) {
      this.fileParts.set(fileId, new Map());
    }
    this.fileParts.get(fileId)!.set(partNum, data);
  }

  assembleFile(fileId: string): Buffer | undefined {
    const parts = this.fileParts.get(fileId);
    if (!parts || parts.size === 0) return undefined;
    const sorted = Array.from(parts.entries()).sort((a, b) => a[0] - b[0]);
    const assembled = Buffer.concat(sorted.map(([, buf]) => buf));
    this.assembledFiles.set(fileId, assembled);
    this.fileParts.delete(fileId);
    return assembled;
  }

  getUploadedFile(fileId: string): Buffer | undefined {
    // Check assembled first, then try to assemble from parts
    if (this.assembledFiles.has(fileId)) return this.assembledFiles.get(fileId);
    return this.assembleFile(fileId);
  }

  // ========== Media persistence (disk + DB) ==========

  private getFilesDir(): string {
    const dir = process.env.FILES_DIR
      ? resolve(process.env.FILES_DIR)
      : resolve(process.cwd(), 'data', 'files');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  saveMedia(input: {
    type: 'photo' | 'document';
    fileData: Buffer;
    mimeType?: string;
    width?: number;
    height?: number;
    fileName?: string;
    duration?: number;
    waveform?: Buffer;
    isVoice?: boolean;
  }): StoredMedia {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db.prepare(`
      INSERT INTO app_media (type, file_path, mime_type, file_size, width, height, file_name, duration, waveform, is_voice, created_at)
      VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.type,
      input.mimeType || 'application/octet-stream',
      input.fileData.length,
      input.width || null,
      input.height || null,
      input.fileName || null,
      input.duration || null,
      input.waveform || null,
      input.isVoice ? 1 : null,
      now,
    );
    const mediaId = Number(result.lastInsertRowid);
    const filePath = resolve(this.getFilesDir(), String(mediaId));
    writeFileSync(filePath, input.fileData);
    this.db.prepare(`UPDATE app_media SET file_path = ? WHERE id = ?`).run(filePath, mediaId);
    return {
      id: mediaId,
      type: input.type,
      filePath,
      mimeType: input.mimeType || 'application/octet-stream',
      fileSize: input.fileData.length,
      width: input.width,
      height: input.height,
      fileName: input.fileName,
      duration: input.duration,
      waveform: input.waveform,
      isVoice: input.isVoice,
      createdAt: now,
    };
  }

  getMedia(mediaId: number): StoredMedia | undefined {
    const row = this.db.prepare(`
      SELECT id, type, file_path, mime_type, file_size, width, height, file_name, duration, waveform, is_voice, created_at
      FROM app_media WHERE id = ?
    `).get(mediaId) as {
      id: number; type: string; file_path: string; mime_type: string;
      file_size: number; width: number | null; height: number | null;
      file_name: string | null; duration: number | null; waveform: Buffer | null;
      is_voice: number | null; created_at: number;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      type: row.type as 'photo' | 'document',
      filePath: row.file_path,
      mimeType: row.mime_type,
      fileSize: row.file_size,
      width: row.width || undefined,
      height: row.height || undefined,
      fileName: row.file_name || undefined,
      duration: row.duration || undefined,
      waveform: row.waveform || undefined,
      isVoice: row.is_voice === 1 || undefined,
      createdAt: row.created_at,
    };
  }

  getMediaFileData(mediaId: number): Buffer | undefined {
    const media = this.getMedia(mediaId);
    if (!media) return undefined;
    try {
      return readFileSync(media.filePath);
    } catch {
      return undefined;
    }
  }

  verifyAuthCode(phone: string, phoneCodeHash: string, code: string): boolean {
    const now = Math.floor(Date.now() / 1000);
    const row = this.db.prepare(`
      SELECT code, phone_code_hash, expires_at FROM auth_codes WHERE phone = ?
    `).get(phone) as { code: string; phone_code_hash: string; expires_at: number } | undefined;
    if (!row) return false;
    if (row.expires_at < now) return false;
    if (row.phone_code_hash !== phoneCodeHash) return false;
    if (row.code !== code) return false;
    // Delete used code
    this.db.prepare(`DELETE FROM auth_codes WHERE phone = ?`).run(phone);
    return true;
  }

  // ========== SESSION MANAGEMENT ==========

  upsertSession(authKeyHex: string, userId: number | undefined, meta?: { deviceModel?: string; platform?: string; appVersion?: string }): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      INSERT INTO sessions (auth_key_hex, user_id, device_model, platform, app_version, created_at, last_activity_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(auth_key_hex) DO UPDATE SET
        user_id = COALESCE(?, user_id),
        device_model = CASE WHEN ? != '' THEN ? ELSE device_model END,
        platform = CASE WHEN ? != '' THEN ? ELSE platform END,
        app_version = CASE WHEN ? != '' THEN ? ELSE app_version END,
        last_activity_at = ?
    `).run(
      authKeyHex, userId || null, meta?.deviceModel || '', meta?.platform || '', meta?.appVersion || '', now, now,
      userId || null,
      meta?.deviceModel || '', meta?.deviceModel || '',
      meta?.platform || '', meta?.platform || '',
      meta?.appVersion || '', meta?.appVersion || '',
      now,
    );
  }

  touchSession(authKeyHex: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`UPDATE sessions SET last_activity_at = ? WHERE auth_key_hex = ?`).run(now, authKeyHex);
  }

  getSessionsForUser(userId: number): Array<{
    authKeyHex: string;
    deviceModel: string;
    platform: string;
    appVersion: string;
    createdAt: number;
    lastActivityAt: number;
  }> {
    const rows = this.db.prepare(`
      SELECT auth_key_hex, device_model, platform, app_version, created_at, last_activity_at
      FROM sessions WHERE user_id = ? ORDER BY last_activity_at DESC
    `).all(userId) as any[];
    return rows.map(r => ({
      authKeyHex: r.auth_key_hex,
      deviceModel: r.device_model,
      platform: r.platform,
      appVersion: r.app_version,
      createdAt: r.created_at,
      lastActivityAt: r.last_activity_at,
    }));
  }

  deleteSession(authKeyHex: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE auth_key_hex = ?`).run(authKeyHex);
  }

  /** Delete sessions that haven't been active for the given TTL (seconds) */
  cleanupExpiredSessions(ttlSeconds: number): number {
    const cutoff = Math.floor(Date.now() / 1000) - ttlSeconds;
    const result = this.db.prepare(`DELETE FROM sessions WHERE last_activity_at < ?`).run(cutoff);
    return result.changes;
  }

  // ========== USER ONLINE STATUS TRACKING ==========

  /** In-memory set of online user IDs (have active authenticated sessions) */
  private onlineUsers = new Set<number>();
  /** In-memory map of userId -> was_online Unix timestamp */
  private userLastSeen = new Map<number, number>();

  setUserOnline(userId: number): void {
    this.onlineUsers.add(userId);
  }

  setUserOffline(userId: number): void {
    this.onlineUsers.delete(userId);
    this.userLastSeen.set(userId, Math.floor(Date.now() / 1000));
  }

  isUserOnline(userId: number): boolean {
    return this.onlineUsers.has(userId);
  }

  getUserLastSeen(userId: number): number | undefined {
    return this.userLastSeen.get(userId);
  }

  /** Get count of active sessions for a user from the clients map perspective */
  getOnlineUserIds(): number[] {
    return Array.from(this.onlineUsers);
  }

  // ========== PRIVACY SETTINGS ==========

  /**
   * Privacy rule types stored in DB:
   * 'allowAll', 'disallowAll', 'allowContacts', 'disallowContacts',
   * 'allowCloseFriends', 'allowPremium', 'allowBots', 'disallowBots',
   * 'allowUsers', 'disallowUsers', 'allowChatParticipants', 'disallowChatParticipants'
   */

  /** Get all privacy rules for a user+key */
  getPrivacyRules(userId: number, privacyKey: string): Array<{ ruleType: string; value: number[] }> {
    const rows = this.db.prepare(
      `SELECT rule_type, value FROM privacy_rules WHERE user_id = ? AND privacy_key = ?`
    ).all(userId, privacyKey) as Array<{ rule_type: string; value: string }>;
    return rows.map(r => ({
      ruleType: r.rule_type,
      value: JSON.parse(r.value) as number[],
    }));
  }

  /** Set privacy rules for a user+key (replaces all existing rules for that key) */
  setPrivacyRules(userId: number, privacyKey: string, rules: Array<{ ruleType: string; value: number[] }>): void {
    const del = this.db.prepare(`DELETE FROM privacy_rules WHERE user_id = ? AND privacy_key = ?`);
    const ins = this.db.prepare(`INSERT INTO privacy_rules (user_id, privacy_key, rule_type, value) VALUES (?, ?, ?, ?)`);
    const txn = this.db.transaction(() => {
      del.run(userId, privacyKey);
      for (const rule of rules) {
        ins.run(userId, privacyKey, rule.ruleType, JSON.stringify(rule.value));
      }
    });
    txn();
  }

  /** Get a global privacy setting */
  getGlobalPrivacySetting(userId: number, key: string): string | undefined {
    const row = this.db.prepare(
      `SELECT setting_value FROM global_privacy_settings WHERE user_id = ? AND setting_key = ?`
    ).get(userId, key) as { setting_value: string } | undefined;
    return row?.setting_value;
  }

  /** Set a global privacy setting */
  setGlobalPrivacySetting(userId: number, key: string, value: string): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO global_privacy_settings (user_id, setting_key, setting_value) VALUES (?, ?, ?)`
    ).run(userId, key, value);
  }

  /** Get all global privacy settings for a user */
  getAllGlobalPrivacySettings(userId: number): Record<string, string> {
    const rows = this.db.prepare(
      `SELECT setting_key, setting_value FROM global_privacy_settings WHERE user_id = ?`
    ).all(userId) as Array<{ setting_key: string; setting_value: string }>;
    const result: Record<string, string> = {};
    for (const row of rows) result[row.setting_key] = row.setting_value;
    return result;
  }

  // ========== CHAT MANAGEMENT ==========

  private getNextChatId(): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(id), 0) AS max_id FROM chats`).get() as { max_id: number };
    return row.max_id + 1;
  }

  createChat(input: {
    type: 'group' | 'supergroup' | 'channel';
    title: string;
    about?: string;
    creatorUserId: number;
    isBroadcast?: boolean;
    isMegagroup?: boolean;
  }): StoredChat {
    const id = this.getNextChatId();
    const accessHash = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
    const now = Math.floor(Date.now() / 1000);

    this.db.prepare(`
      INSERT INTO chats (id, type, title, about, creator_user_id, access_hash, date, participants_count, is_broadcast, is_megagroup)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.type, input.title, input.about || '', input.creatorUserId, accessHash.toString(), now, 1, input.isBroadcast ? 1 : 0, input.isMegagroup ? 1 : 0);

    // Add creator as participant
    this.addChatParticipant(id, input.creatorUserId, 'creator', undefined);

    return {
      id,
      type: input.type,
      title: input.title,
      about: input.about || '',
      creatorUserId: input.creatorUserId,
      accessHash,
      date: now,
      participantsCount: 1,
      isBroadcast: Boolean(input.isBroadcast),
      isMegagroup: Boolean(input.isMegagroup),
    };
  }

  getChatById(chatId: number): StoredChat | undefined {
    const row = this.db.prepare(`
      SELECT id, type, title, about, creator_user_id, access_hash, date, participants_count, is_broadcast, is_megagroup, photo_id
      FROM chats WHERE id = ?
    `).get(chatId) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      about: row.about,
      creatorUserId: row.creator_user_id,
      accessHash: BigInt(row.access_hash),
      date: row.date,
      participantsCount: row.participants_count,
      isBroadcast: row.is_broadcast === 1,
      isMegagroup: row.is_megagroup === 1,
      photoId: row.photo_id || undefined,
    };
  }

  updateChat(chatId: number, fields: { title?: string; about?: string; photoId?: number }): void {
    const sets: string[] = [];
    const params: any[] = [];
    if (fields.title !== undefined) { sets.push('title = ?'); params.push(fields.title); }
    if (fields.about !== undefined) { sets.push('about = ?'); params.push(fields.about); }
    if (fields.photoId !== undefined) { sets.push('photo_id = ?'); params.push(fields.photoId); }
    if (sets.length === 0) return;
    params.push(chatId);
    this.db.prepare(`UPDATE chats SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  addChatParticipant(chatId: number, userId: number, role: 'creator' | 'admin' | 'member', inviterId?: number): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      INSERT INTO chat_participants (chat_id, user_id, role, inviter_id, date)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, user_id) DO UPDATE SET role = excluded.role, inviter_id = excluded.inviter_id
    `).run(chatId, userId, role, inviterId ?? null, now);

    // Update participants count
    const countRow = this.db.prepare(`SELECT COUNT(*) as cnt FROM chat_participants WHERE chat_id = ?`).get(chatId) as { cnt: number };
    this.db.prepare(`UPDATE chats SET participants_count = ? WHERE id = ?`).run(countRow.cnt, chatId);
  }

  removeChatParticipant(chatId: number, userId: number): void {
    this.db.prepare(`DELETE FROM chat_participants WHERE chat_id = ? AND user_id = ?`).run(chatId, userId);
    const countRow = this.db.prepare(`SELECT COUNT(*) as cnt FROM chat_participants WHERE chat_id = ?`).get(chatId) as { cnt: number };
    this.db.prepare(`UPDATE chats SET participants_count = ? WHERE id = ?`).run(countRow.cnt, chatId);
  }

  getChatParticipants(chatId: number): StoredChatParticipant[] {
    const rows = this.db.prepare(`
      SELECT chat_id, user_id, role, inviter_id, date, rank
      FROM chat_participants WHERE chat_id = ?
    `).all(chatId) as Array<{ chat_id: number; user_id: number; role: string; inviter_id: number | null; date: number; rank: string | null }>;
    return rows.map(r => ({
      chatId: r.chat_id,
      userId: r.user_id,
      role: r.role as 'creator' | 'admin' | 'member',
      inviterId: r.inviter_id || undefined,
      date: r.date,
      rank: r.rank || undefined,
    }));
  }

  getChatParticipant(chatId: number, userId: number): StoredChatParticipant | undefined {
    const row = this.db.prepare(`
      SELECT chat_id, user_id, role, inviter_id, date, rank
      FROM chat_participants WHERE chat_id = ? AND user_id = ?
    `).get(chatId, userId) as { chat_id: number; user_id: number; role: string; inviter_id: number | null; date: number; rank: string | null } | undefined;
    if (!row) return undefined;
    return {
      chatId: row.chat_id,
      userId: row.user_id,
      role: row.role as 'creator' | 'admin' | 'member',
      inviterId: row.inviter_id || undefined,
      date: row.date,
      rank: row.rank || undefined,
    };
  }

  setParticipantRole(chatId: number, userId: number, role: 'creator' | 'admin' | 'member', rank?: string): void {
    this.db.prepare(`
      UPDATE chat_participants SET role = ?, rank = ? WHERE chat_id = ? AND user_id = ?
    `).run(role, rank || null, chatId, userId);
  }

  /** Get all chat IDs where a user is a participant */
  getChatsForUser(userId: number): number[] {
    const rows = this.db.prepare(`
      SELECT chat_id FROM chat_participants WHERE user_id = ?
    `).all(userId) as { chat_id: number }[];
    return rows.map(r => r.chat_id);
  }

  /** Delete a chat and all its participants, messages, drafts, and reactions */
  deleteChat(chatId: number, peerKey: string): void {
    this.db.prepare(`DELETE FROM chat_participants WHERE chat_id = ?`).run(chatId);
    this.db.prepare(`DELETE FROM app_messages WHERE peer_key = ?`).run(peerKey);
    this.db.prepare(`DELETE FROM drafts WHERE peer_key = ?`).run(peerKey);
    this.db.prepare(`DELETE FROM reactions WHERE peer_key = ?`).run(peerKey);
    this.db.prepare(`DELETE FROM chats WHERE id = ?`).run(chatId);
  }

  // ========== DRAFTS ==========

  saveDraft(ownerUserId: number, peerKey: string, text: string, replyToMsgId?: number): void {
    const now = Math.floor(Date.now() / 1000);
    if (!text.trim()) {
      this.db.prepare(`DELETE FROM drafts WHERE owner_user_id = ? AND peer_key = ?`).run(ownerUserId, peerKey);
      return;
    }
    this.db.prepare(`
      INSERT INTO drafts (owner_user_id, peer_key, text, date, reply_to_msg_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(owner_user_id, peer_key) DO UPDATE SET text = excluded.text, date = excluded.date, reply_to_msg_id = excluded.reply_to_msg_id
    `).run(ownerUserId, peerKey, text, now, replyToMsgId || null);
  }

  getDraft(ownerUserId: number, peerKey: string): StoredDraft | undefined {
    const row = this.db.prepare(`
      SELECT owner_user_id, peer_key, text, date, reply_to_msg_id
      FROM drafts WHERE owner_user_id = ? AND peer_key = ?
    `).get(ownerUserId, peerKey) as { owner_user_id: number; peer_key: string; text: string; date: number; reply_to_msg_id: number | null } | undefined;
    if (!row) return undefined;
    return {
      ownerUserId: row.owner_user_id,
      peerKey: row.peer_key,
      text: row.text,
      date: row.date,
      replyToMsgId: row.reply_to_msg_id || undefined,
    };
  }

  deleteDraft(ownerUserId: number, peerKey: string): void {
    this.db.prepare(`DELETE FROM drafts WHERE owner_user_id = ? AND peer_key = ?`).run(ownerUserId, peerKey);
  }

  getAllDrafts(ownerUserId: number): StoredDraft[] {
    const rows = this.db.prepare(`
      SELECT owner_user_id, peer_key, text, date, reply_to_msg_id
      FROM drafts WHERE owner_user_id = ?
    `).all(ownerUserId) as Array<{ owner_user_id: number; peer_key: string; text: string; date: number; reply_to_msg_id: number | null }>;
    return rows.map(r => ({
      ownerUserId: r.owner_user_id,
      peerKey: r.peer_key,
      text: r.text,
      date: r.date,
      replyToMsgId: r.reply_to_msg_id || undefined,
    }));
  }

  // ========== REACTIONS ==========

  setReaction(ownerUserId: number, peerKey: string, messageId: number, userId: number, emoticon: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      INSERT INTO reactions (owner_user_id, peer_key, message_id, user_id, emoticon, date)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_user_id, peer_key, message_id, user_id) DO UPDATE SET emoticon = excluded.emoticon, date = excluded.date
    `).run(ownerUserId, peerKey, messageId, userId, emoticon, now);
  }

  removeReaction(ownerUserId: number, peerKey: string, messageId: number, userId: number): void {
    this.db.prepare(`DELETE FROM reactions WHERE owner_user_id = ? AND peer_key = ? AND message_id = ? AND user_id = ?`).run(ownerUserId, peerKey, messageId, userId);
  }

  getReactions(ownerUserId: number, peerKey: string, messageId: number): StoredReaction[] {
    const rows = this.db.prepare(`
      SELECT owner_user_id, peer_key, message_id, user_id, emoticon, date
      FROM reactions WHERE owner_user_id = ? AND peer_key = ? AND message_id = ?
    `).all(ownerUserId, peerKey, messageId) as Array<{ owner_user_id: number; peer_key: string; message_id: number; user_id: number; emoticon: string; date: number }>;
    return rows.map(r => ({
      ownerUserId: r.owner_user_id,
      peerKey: r.peer_key,
      messageId: r.message_id,
      userId: r.user_id,
      emoticon: r.emoticon,
      date: r.date,
    }));
  }

  appendReactionEvent(ownerUserId: number, peerKey: string, messageId: number): { pts: number; ptsCount: number } {
    const result = this.appendUpdateEvent(ownerUserId, { kind: 'reaction', peerKey, messageId });
    return { pts: result.pts, ptsCount: result.ptsCount };
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_messages (
        owner_user_id INTEGER NOT NULL,
        peer_key TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        client_random_id TEXT,
        date INTEGER NOT NULL,
        text TEXT NOT NULL,
        is_outgoing INTEGER NOT NULL DEFAULT 1,
        from_peer_key TEXT,
        post INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        edit_date INTEGER,
        reply_to_msg_id INTEGER,
        quote_text TEXT,
        quote_offset INTEGER,
        PRIMARY KEY (owner_user_id, peer_key, message_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_app_messages_random_id
        ON app_messages (owner_user_id, peer_key, client_random_id)
        WHERE client_random_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS app_peer_counters (
        owner_user_id INTEGER NOT NULL,
        peer_key TEXT NOT NULL,
        next_message_id INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner_user_id, peer_key)
      );

      CREATE TABLE IF NOT EXISTS app_peer_state (
        owner_user_id INTEGER NOT NULL,
        peer_key TEXT NOT NULL,
        read_inbox_max_id INTEGER NOT NULL DEFAULT 0,
        read_outbox_max_id INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner_user_id, peer_key)
      );

      CREATE TABLE IF NOT EXISTS app_updates_state (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        pts INTEGER NOT NULL,
        qts INTEGER NOT NULL DEFAULT 0,
        date INTEGER NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        unread_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_updates_log (
        pts INTEGER PRIMARY KEY,
        pts_count INTEGER NOT NULL,
        date INTEGER NOT NULL,
        kind TEXT NOT NULL,
        peer_key TEXT NOT NULL,
        message_id INTEGER,
        max_id INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_keys (
        key_id_hex TEXT PRIMARY KEY,
        auth_key BLOB NOT NULL,
        user_id INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        phone TEXT NOT NULL UNIQUE,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL DEFAULT '',
        photo_id INTEGER,
        access_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        username TEXT,
        about TEXT,
        is_bot INTEGER NOT NULL DEFAULT 0,
        bot_info_version INTEGER,
        bot_inline_placeholder TEXT,
        bot_active_users INTEGER,
        verified INTEGER NOT NULL DEFAULT 0,
        restricted INTEGER NOT NULL DEFAULT 0,
        scam INTEGER NOT NULL DEFAULT 0,
        fake INTEGER NOT NULL DEFAULT 0,
        premium INTEGER NOT NULL DEFAULT 0,
        lang_code TEXT,
        emoji_status_document_id TEXT,
        emoji_status_until INTEGER,
        color_id INTEGER,
        color_background_emoji_id TEXT,
        profile_color_id INTEGER,
        profile_color_background_emoji_id TEXT,
        birthday_day INTEGER,
        birthday_month INTEGER,
        birthday_year INTEGER,
        common_chats_count INTEGER NOT NULL DEFAULT 0,
        pinned_msg_id INTEGER,
        phone_calls_available INTEGER NOT NULL DEFAULT 0,
        phone_calls_private INTEGER NOT NULL DEFAULT 0,
        video_calls_available INTEGER NOT NULL DEFAULT 0,
        voice_messages_forbidden INTEGER NOT NULL DEFAULT 0,
        private_forward_name TEXT,
        ttl_period INTEGER,
        theme_emoticon TEXT,
        contact_require_premium INTEGER NOT NULL DEFAULT 0,
        personal_channel_id INTEGER,
        personal_channel_message INTEGER,
        stargifts_count INTEGER
      );

      CREATE TABLE IF NOT EXISTS auth_codes (
        phone TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        phone_code_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        auth_key_hex TEXT PRIMARY KEY,
        user_id INTEGER,
        device_model TEXT NOT NULL DEFAULT '',
        platform TEXT NOT NULL DEFAULT '',
        app_version TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        file_size INTEGER NOT NULL DEFAULT 0,
        width INTEGER,
        height INTEGER,
        file_name TEXT,
        duration INTEGER,
        waveform BLOB,
        is_voice INTEGER,
        created_at INTEGER NOT NULL
      );
    `);

    // Migration: add user_id column to auth_keys if missing
    const authKeysInfo = this.db.prepare(`PRAGMA table_info(auth_keys)`).all() as Array<{ name: string }>;
    if (!authKeysInfo.some(c => c.name === 'user_id')) {
      this.db.exec(`ALTER TABLE auth_keys ADD COLUMN user_id INTEGER`);
    }

    // Migration: recreate app_messages/peer_counters/peer_state with owner_user_id if missing
    const msgInfo = this.db.prepare(`PRAGMA table_info(app_messages)`).all() as Array<{ name: string }>;
    if (!msgInfo.some(c => c.name === 'owner_user_id')) {
      console.log('[DB Migration] Recreating app_messages, app_peer_counters, app_peer_state with owner_user_id');
      this.db.exec(`
        DROP TABLE IF EXISTS app_messages;
        DROP TABLE IF EXISTS app_peer_counters;
        DROP TABLE IF EXISTS app_peer_state;
        DROP TABLE IF EXISTS app_updates_log;
      `);
      // Re-run schema creation for the dropped tables
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS app_messages (
          owner_user_id INTEGER NOT NULL,
          peer_key TEXT NOT NULL,
          message_id INTEGER NOT NULL,
          client_random_id TEXT,
          date INTEGER NOT NULL,
          text TEXT NOT NULL,
          is_outgoing INTEGER NOT NULL DEFAULT 1,
          from_peer_key TEXT,
          post INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          edit_date INTEGER,
          reply_to_msg_id INTEGER,
          quote_text TEXT,
          quote_offset INTEGER,
          media_id INTEGER,
          PRIMARY KEY (owner_user_id, peer_key, message_id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_app_messages_random_id
          ON app_messages (owner_user_id, peer_key, client_random_id)
          WHERE client_random_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS app_peer_counters (
          owner_user_id INTEGER NOT NULL,
          peer_key TEXT NOT NULL,
          next_message_id INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (owner_user_id, peer_key)
        );
        CREATE TABLE IF NOT EXISTS app_peer_state (
          owner_user_id INTEGER NOT NULL,
          peer_key TEXT NOT NULL,
          read_inbox_max_id INTEGER NOT NULL DEFAULT 0,
          read_outbox_max_id INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (owner_user_id, peer_key)
        );
        CREATE TABLE IF NOT EXISTS app_updates_log (
          owner_user_id INTEGER NOT NULL,
          pts INTEGER NOT NULL,
          pts_count INTEGER NOT NULL,
          date INTEGER NOT NULL,
          kind TEXT NOT NULL,
          peer_key TEXT NOT NULL,
          message_id INTEGER,
          max_id INTEGER,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (owner_user_id, pts)
        );
      `);
      // Reset update state since logs were cleared
      this.db.exec(`DELETE FROM app_updates_state`);
    }

    // Migration: convert app_updates_state from singleton_id to owner_user_id if needed
    const updatesStateInfo = this.db.prepare(`PRAGMA table_info(app_updates_state)`).all() as Array<{ name: string }>;
    if (updatesStateInfo.some(c => c.name === 'singleton_id')) {
      console.log('[DB Migration] Recreating app_updates_state and app_updates_log with owner_user_id');
      this.db.exec(`
        DROP TABLE IF EXISTS app_updates_state;
        DROP TABLE IF EXISTS app_updates_log;
        CREATE TABLE IF NOT EXISTS app_updates_state (
          owner_user_id INTEGER PRIMARY KEY,
          pts INTEGER NOT NULL,
          qts INTEGER NOT NULL DEFAULT 0,
          date INTEGER NOT NULL,
          seq INTEGER NOT NULL DEFAULT 0,
          unread_count INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS app_updates_log (
          owner_user_id INTEGER NOT NULL,
          pts INTEGER NOT NULL,
          pts_count INTEGER NOT NULL,
          date INTEGER NOT NULL,
          kind TEXT NOT NULL,
          peer_key TEXT NOT NULL,
          message_id INTEGER,
          max_id INTEGER,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (owner_user_id, pts)
        );
        CREATE INDEX IF NOT EXISTS idx_app_updates_log_user_pts
          ON app_updates_log (owner_user_id, pts);
      `);
    }

    // Migration: add username column to users if missing
    const usersInfo = this.db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>;
    if (!usersInfo.some(c => c.name === 'username')) {
      this.db.exec(`ALTER TABLE users ADD COLUMN username TEXT`);
    }
    if (!usersInfo.some(c => c.name === 'photo_id')) {
      this.db.exec(`ALTER TABLE users ADD COLUMN photo_id INTEGER`);
    }
    // Migration: add extended user fields
    const extUserCols: Array<[string, string]> = [
      ['about', 'TEXT'],
      ['is_bot', 'INTEGER NOT NULL DEFAULT 0'],
      ['bot_info_version', 'INTEGER'],
      ['bot_inline_placeholder', 'TEXT'],
      ['bot_active_users', 'INTEGER'],
      ['verified', 'INTEGER NOT NULL DEFAULT 0'],
      ['restricted', 'INTEGER NOT NULL DEFAULT 0'],
      ['scam', 'INTEGER NOT NULL DEFAULT 0'],
      ['fake', 'INTEGER NOT NULL DEFAULT 0'],
      ['premium', 'INTEGER NOT NULL DEFAULT 0'],
      ['lang_code', 'TEXT'],
      ['emoji_status_document_id', 'TEXT'],
      ['emoji_status_until', 'INTEGER'],
      ['color_id', 'INTEGER'],
      ['color_background_emoji_id', 'TEXT'],
      ['profile_color_id', 'INTEGER'],
      ['profile_color_background_emoji_id', 'TEXT'],
      ['birthday_day', 'INTEGER'],
      ['birthday_month', 'INTEGER'],
      ['birthday_year', 'INTEGER'],
      ['common_chats_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['pinned_msg_id', 'INTEGER'],
      ['phone_calls_available', 'INTEGER NOT NULL DEFAULT 0'],
      ['phone_calls_private', 'INTEGER NOT NULL DEFAULT 0'],
      ['video_calls_available', 'INTEGER NOT NULL DEFAULT 0'],
      ['voice_messages_forbidden', 'INTEGER NOT NULL DEFAULT 0'],
      ['private_forward_name', 'TEXT'],
      ['ttl_period', 'INTEGER'],
      ['theme_emoticon', 'TEXT'],
      ['contact_require_premium', 'INTEGER NOT NULL DEFAULT 0'],
      ['personal_channel_id', 'INTEGER'],
      ['personal_channel_message', 'INTEGER'],
      ['stargifts_count', 'INTEGER'],
    ];
    for (const [col, def] of extUserCols) {
      if (!usersInfo.some(c => c.name === col)) {
        this.db.exec(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
      }
    }

    // Migration: add reply_to_msg_id column to app_messages if missing
    const msgColInfo = this.db.prepare(`PRAGMA table_info(app_messages)`).all() as Array<{ name: string }>;
    if (!msgColInfo.some(c => c.name === 'reply_to_msg_id')) {
      this.db.exec(`ALTER TABLE app_messages ADD COLUMN reply_to_msg_id INTEGER`);
    }
    if (!msgColInfo.some(c => c.name === 'quote_text')) {
      this.db.exec(`ALTER TABLE app_messages ADD COLUMN quote_text TEXT`);
    }
    if (!msgColInfo.some(c => c.name === 'quote_offset')) {
      this.db.exec(`ALTER TABLE app_messages ADD COLUMN quote_offset INTEGER`);
    }
    if (!msgColInfo.some(c => c.name === 'media_id')) {
      this.db.exec(`ALTER TABLE app_messages ADD COLUMN media_id INTEGER`);
    }

    // Migration: create app_media table if missing
    const tables = this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='app_media'`).all();
    if (tables.length === 0) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS app_media (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          file_path TEXT NOT NULL,
          mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
          file_size INTEGER NOT NULL DEFAULT 0,
          width INTEGER,
          height INTEGER,
          file_name TEXT,
          created_at INTEGER NOT NULL
        )
      `);
    }

    // Migration: FTS5 full-text search index on message text
    const ftsExists = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='app_messages_fts'`
    ).all();
    if (ftsExists.length === 0) {
      console.log('[DB Migration] Creating FTS5 index app_messages_fts');
      this.db.exec(`
        CREATE VIRTUAL TABLE app_messages_fts USING fts5(
          text,
          content=app_messages,
          content_rowid=rowid
        );

        -- Populate FTS from existing messages
        INSERT INTO app_messages_fts(rowid, text)
          SELECT rowid, text FROM app_messages;

        -- Keep FTS in sync on INSERT
        CREATE TRIGGER app_messages_ai AFTER INSERT ON app_messages BEGIN
          INSERT INTO app_messages_fts(rowid, text) VALUES (new.rowid, new.text);
        END;

        -- Keep FTS in sync on DELETE
        CREATE TRIGGER app_messages_ad AFTER DELETE ON app_messages BEGIN
          INSERT INTO app_messages_fts(app_messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
        END;

        -- Keep FTS in sync on UPDATE
        CREATE TRIGGER app_messages_au AFTER UPDATE ON app_messages BEGIN
          INSERT INTO app_messages_fts(app_messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
          INSERT INTO app_messages_fts(rowid, text) VALUES (new.rowid, new.text);
        END;
      `);
    }

    // Migration: add fwd_from columns to app_messages if missing
    const msgColInfo2 = this.db.prepare(`PRAGMA table_info(app_messages)`).all() as Array<{ name: string }>;
    if (!msgColInfo2.some(c => c.name === 'fwd_from_peer_key')) {
      this.db.exec(`ALTER TABLE app_messages ADD COLUMN fwd_from_peer_key TEXT`);
    }
    if (!msgColInfo2.some(c => c.name === 'fwd_from_name')) {
      this.db.exec(`ALTER TABLE app_messages ADD COLUMN fwd_from_name TEXT`);
    }
    if (!msgColInfo2.some(c => c.name === 'fwd_date')) {
      this.db.exec(`ALTER TABLE app_messages ADD COLUMN fwd_date INTEGER`);
    }
    if (!msgColInfo2.some(c => c.name === 'action_type')) {
      this.db.exec(`ALTER TABLE app_messages ADD COLUMN action_type TEXT`);
    }

    // Migration: create chats table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id INTEGER PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'group',
        title TEXT NOT NULL,
        about TEXT NOT NULL DEFAULT '',
        creator_user_id INTEGER NOT NULL,
        access_hash TEXT NOT NULL,
        date INTEGER NOT NULL,
        participants_count INTEGER NOT NULL DEFAULT 0,
        is_broadcast INTEGER NOT NULL DEFAULT 0,
        is_megagroup INTEGER NOT NULL DEFAULT 0,
        photo_id INTEGER
      );
    `);

    // Migration: add photo_id column to chats if missing
    try {
      this.db.exec(`ALTER TABLE chats ADD COLUMN photo_id INTEGER`);
    } catch (_e) { /* column already exists */ }

    // Migration: create chat_participants table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_participants (
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        inviter_id INTEGER,
        date INTEGER NOT NULL,
        rank TEXT,
        PRIMARY KEY (chat_id, user_id)
      );
    `);

    // Migration: create drafts table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS drafts (
        owner_user_id INTEGER NOT NULL,
        peer_key TEXT NOT NULL,
        text TEXT NOT NULL,
        date INTEGER NOT NULL,
        reply_to_msg_id INTEGER,
        PRIMARY KEY (owner_user_id, peer_key)
      );
    `);

    // Migration: add read_inbox_ts column to app_peer_state if missing
    const peerStateInfo = this.db.prepare(`PRAGMA table_info(app_peer_state)`).all() as Array<{ name: string }>;
    if (!peerStateInfo.some(c => c.name === 'read_inbox_ts')) {
      this.db.exec(`ALTER TABLE app_peer_state ADD COLUMN read_inbox_ts INTEGER NOT NULL DEFAULT 0`);
    }

    // Migration: add audio fields to app_media if missing
    const mediaInfo = this.db.prepare(`PRAGMA table_info(app_media)`).all() as Array<{ name: string }>;
    if (!mediaInfo.some(c => c.name === 'duration')) {
      this.db.exec(`ALTER TABLE app_media ADD COLUMN duration INTEGER`);
    }
    if (!mediaInfo.some(c => c.name === 'waveform')) {
      this.db.exec(`ALTER TABLE app_media ADD COLUMN waveform BLOB`);
    }
    if (!mediaInfo.some(c => c.name === 'is_voice')) {
      this.db.exec(`ALTER TABLE app_media ADD COLUMN is_voice INTEGER`);
    }

    // Migration: create reactions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reactions (
        owner_user_id INTEGER NOT NULL,
        peer_key TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        emoticon TEXT NOT NULL,
        date INTEGER NOT NULL,
        PRIMARY KEY (owner_user_id, peer_key, message_id, user_id)
      );
    `);

    // Privacy rules table: stores per-user per-key privacy rules
    // rule_type maps to TL PrivacyRule constructors (e.g. 'allowAll', 'disallowAll', 'allowContacts', etc.)
    // value is a JSON array of user/chat IDs for AllowUsers/DisallowUsers/AllowChatParticipants/DisallowChatParticipants
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS privacy_rules (
        user_id INTEGER NOT NULL,
        privacy_key TEXT NOT NULL,
        rule_type TEXT NOT NULL,
        value TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (user_id, privacy_key, rule_type)
      );
    `);

    // Global privacy settings per user (key-value)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS global_privacy_settings (
        user_id INTEGER NOT NULL,
        setting_key TEXT NOT NULL,
        setting_value TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (user_id, setting_key)
      );
    `);
  }

  private reconcileUpdateState() {
    // Reconcile per-user pts: for each user that has messages, ensure their pts is at least
    // as high as the max logged pts and max message_id
    const userIds = this.db.prepare(`
      SELECT DISTINCT owner_user_id FROM app_messages
      UNION
      SELECT DISTINCT owner_user_id FROM app_updates_log
    `).all() as { owner_user_id: number }[];

    for (const { owner_user_id: userId } of userIds) {
      const currentState = this.getUpdateState(userId);

      const maxLoggedPtsRow = this.db.prepare(`
        SELECT COALESCE(MAX(pts), 0) AS max_pts FROM app_updates_log WHERE owner_user_id = ?
      `).get(userId) as { max_pts: number };

      const maxMsgRow = this.db.prepare(`
        SELECT COALESCE(MAX(message_id), 0) AS max_msg_id FROM app_messages WHERE owner_user_id = ?
      `).get(userId) as { max_msg_id: number };

      const reconciledPts = Math.max(currentState.pts, maxLoggedPtsRow.max_pts, maxMsgRow.max_msg_id, 1);
      const reconciledDate = Math.max(currentState.date, Math.floor(Date.now() / 1000));

      if (reconciledPts !== currentState.pts || reconciledDate !== currentState.date) {
        this.db.prepare(`
          UPDATE app_updates_state SET pts = ?, date = ?, updated_at = ? WHERE owner_user_id = ?
        `).run(reconciledPts, reconciledDate, Math.floor(Date.now() / 1000), userId);
      }
    }
  }

  private reserveMessageId(ownerUserId: number, peerKey: string, minNextMessageId: number) {
    const now = Math.floor(Date.now() / 1000);
    const current = this.db.prepare(`
      SELECT next_message_id
      FROM app_peer_counters
      WHERE owner_user_id = ? AND peer_key = ?
    `).get(ownerUserId, peerKey) as { next_message_id: number } | undefined;

    const nextMessageId = current
      ? Math.max(current.next_message_id, minNextMessageId)
      : Math.max(1, minNextMessageId);

    this.db.prepare(`
      INSERT INTO app_peer_counters (owner_user_id, peer_key, next_message_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(owner_user_id, peer_key) DO UPDATE SET
        next_message_id = excluded.next_message_id,
        updated_at = excluded.updated_at
    `).run(ownerUserId, peerKey, nextMessageId + 1, now);

    return nextMessageId;
  }

  private upsertPeerState(ownerUserId: number, peerKey: string, readInboxMaxId: number, readOutboxMaxId: number, inboxTs?: number) {
    const now = Math.floor(Date.now() / 1000);
    const ts = inboxTs ?? now;
    this.db.prepare(`
      INSERT INTO app_peer_state (
        owner_user_id,
        peer_key,
        read_inbox_max_id,
        read_outbox_max_id,
        read_inbox_ts,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_user_id, peer_key) DO UPDATE SET
        read_inbox_max_id = excluded.read_inbox_max_id,
        read_outbox_max_id = excluded.read_outbox_max_id,
        read_inbox_ts = CASE WHEN excluded.read_inbox_max_id > read_inbox_max_id THEN excluded.read_inbox_ts ELSE COALESCE(read_inbox_ts, excluded.read_inbox_ts) END,
        updated_at = excluded.updated_at
    `).run(ownerUserId, peerKey, readInboxMaxId, readOutboxMaxId, ts, now);
  }

  private appendUpdateEvent(ownerUserId: number, input: {
    kind: StoredUpdateEvent['kind'];
    peerKey: string;
    messageId?: number;
    maxId?: number;
    ptsCount?: number;
  }) {
    const state = this.getUpdateState(ownerUserId);
    const ptsCount = input.ptsCount || 1;
    const nextPts = state.pts + ptsCount;
    const now = Math.floor(Date.now() / 1000);

    this.db.prepare(`
      UPDATE app_updates_state
      SET pts = ?, date = ?, updated_at = ?
      WHERE owner_user_id = ?
    `).run(nextPts, now, now, ownerUserId);

    this.db.prepare(`
      INSERT INTO app_updates_log (
        owner_user_id,
        pts,
        pts_count,
        date,
        kind,
        peer_key,
        message_id,
        max_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ownerUserId,
      nextPts,
      ptsCount,
      now,
      input.kind,
      input.peerKey,
      input.messageId || null,
      input.maxId || null,
      now,
    );

    return {
      pts: nextPts,
      qts: state.qts,
      date: now,
      seq: state.seq,
      unreadCount: state.unreadCount,
      ptsCount,
    };
  }
}

let cachedMessageStore: MessageStore | undefined;

export function getMessageStore() {
  if (!cachedMessageStore) {
    cachedMessageStore = new MessageStore();
  }

  return cachedMessageStore;
}

function mapMessageRow(row: MessageRow): StoredMessage {
  return {
    peerKey: row.peer_key,
    messageId: row.message_id,
    clientRandomId: row.client_random_id || undefined,
    date: row.date,
    text: row.text,
    isOutgoing: row.is_outgoing === 1,
    fromPeerKey: row.from_peer_key || undefined,
    post: row.post === 1,
    editDate: row.edit_date || undefined,
    replyToMsgId: row.reply_to_msg_id || undefined,
    quoteText: row.quote_text || undefined,
    quoteOffset: row.quote_offset ?? undefined,
    mediaId: row.media_id || undefined,
    fwdFromPeerKey: row.fwd_from_peer_key || undefined,
    fwdFromName: row.fwd_from_name || undefined,
    fwdDate: row.fwd_date || undefined,
    actionType: row.action_type || undefined,
  };
}

function mapUpdateStateRow(row: UpdateStateRow): StoredUpdateState {
  return {
    pts: row.pts,
    qts: row.qts,
    date: row.date,
    seq: row.seq,
    unreadCount: row.unread_count,
  };
}

function mapUpdateEventRow(row: UpdateEventRow): StoredUpdateEvent {
  return {
    pts: row.pts,
    ptsCount: row.pts_count,
    date: row.date,
    kind: row.kind as StoredUpdateEvent['kind'],
    peerKey: row.peer_key,
    messageId: row.message_id || undefined,
    maxId: row.max_id || undefined,
  };
}
