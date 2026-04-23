import { getMessageStore } from '../database/messageStore.js';
import type {
  FixtureDialog,
  FixtureMessage,
  FixtureUser,
  OfficialCaptureFixture,
} from './officialCaptureFixture.js';

const messageStore = getMessageStore();

export const SEED_USER_ID = 100000;

function getReactionsForMessage(ownerUserId: number, peerKey: string, messageId: number, selfUserId: number): FixtureMessage['reactions'] {
  const stored = messageStore.getReactions(ownerUserId, peerKey, messageId);
  if (!stored || stored.length === 0) return undefined;
  // Aggregate by emoticon
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

export function buildActionForFixture(peerKey: string, actionType?: string, text?: string, mediaId?: number): FixtureMessage['action'] | undefined {
  if (!actionType) return undefined;
  if (actionType === 'chat_create') {
    const chatIdStr = peerKey.startsWith('chat:') ? peerKey.split(':')[1] : undefined;
    const chatId = chatIdStr ? Number(chatIdStr) : 0;
    const participants = chatId ? messageStore.getChatParticipants(chatId) : [];
    return { type: 'chatCreate', title: text || '', userIds: participants.map(p => p.userId) };
  }
  if (actionType === 'channel_create') {
    return { type: 'channelCreate', title: text || '' };
  }
  if (actionType === 'chat_edit_photo') {
    return { type: 'chatEditPhoto', title: '', photoId: mediaId };
  }
  if (actionType === 'chat_delete_user') {
    const userId = text ? Number(text) : 0;
    return { type: 'chatDeleteUser', title: '', userId };
  }
  if (actionType === 'phone_call') {
    try {
      const meta = text ? JSON.parse(text) : {};
      return {
        type: 'phoneCall',
        title: '',
        callId: String(meta.callId || '0'),
        duration: meta.duration,
        reason: meta.reason,
        isVideo: Boolean(meta.video),
      };
    } catch {
      return { type: 'phoneCall', title: '', callId: '0' };
    }
  }
  return undefined;
}

// ========== Message list helpers ==========

export function listStoredMessagesAsFixture(peerKey: string, selfId: number = SEED_USER_ID): FixtureMessage[] {
  const isSavedMessages = peerKey === `user:${selfId}`;
  return messageStore.listMessages(selfId, peerKey).map((message) => ({
    id: message.messageId,
    peerKey: message.peerKey,
    date: message.date,
    text: message.text,
    className: message.actionType ? 'MessageService' : 'Message',
    out: isSavedMessages ? false : message.isOutgoing,
    post: message.post,
    fromPeerKey: isSavedMessages ? undefined : message.fromPeerKey,
    savedPeerKey: isSavedMessages ? `user:${SEED_USER_ID}` : undefined,
    editDate: message.editDate,
    replyToMsgId: message.replyToMsgId,
    quoteText: message.quoteText,
    quoteOffset: message.quoteOffset,
    mediaId: message.mediaId,
    fwdFromPeerKey: message.fwdFromPeerKey,
    fwdFromName: message.fwdFromName,
    fwdDate: message.fwdDate,
    action: buildActionForFixture(message.peerKey, message.actionType, message.text, message.mediaId),
    reactions: getReactionsForMessage(selfId, peerKey, message.messageId, selfId),
    entities: message.entities,
  }));
}

export function listStoredMessagesAsFixtureForUser(peerKey: string, userId: number): FixtureMessage[] {
  const isSavedMessages = peerKey === `user:${userId}`;
  return messageStore.listMessagesForUser(peerKey, userId).map((message) => ({
    id: message.messageId,
    peerKey: message.peerKey,
    date: message.date,
    text: message.text,
    className: message.actionType ? 'MessageService' : 'Message',
    out: isSavedMessages ? false : message.isOutgoing,
    post: message.post,
    fromPeerKey: isSavedMessages ? undefined : message.fromPeerKey,
    savedPeerKey: isSavedMessages ? `user:${userId}` : undefined,
    editDate: message.editDate,
    replyToMsgId: message.replyToMsgId,
    quoteText: message.quoteText,
    quoteOffset: message.quoteOffset,
    mediaId: message.mediaId,
    fwdFromPeerKey: message.fwdFromPeerKey,
    fwdFromName: message.fwdFromName,
    fwdDate: message.fwdDate,
    action: buildActionForFixture(message.peerKey, message.actionType, message.text, message.mediaId),
    reactions: getReactionsForMessage(userId, peerKey, message.messageId, userId),
    entities: message.entities,
  }));
}

/**
 * Build the FixtureMessage that should be delivered to a **recipient** of a P2P or
 * group/channel message we just stored on their side.
 *
 * Rationale: when we duplicate a message into the recipient's store, the freshly
 * inserted row is `is_outgoing=1` (see `appendOutgoingMessage`). We then call
 * `markMessageIncoming` to flip the DB flag, but `getStoredMessageAsFixture`
 * recomputes `out` from whatever state it re-reads. For broadcast fixtures we
 * must strictly enforce `out=false` and `fromPeerKey=<sender>`, otherwise the
 * recipient client will see the incoming message as one of *their own* outgoing
 * ones (wrong avatar, wrong alignment, no notification).
 *
 * This helper consolidates that post-hoc patch so we never forget to apply it
 * in forwardMessages / group-broadcast paths (see audit item #1).
 */
export function prepareRecipientFixture(
  peerKey: string,
  messageId: number,
  recipientUserId: number,
  senderUserId: number,
): FixtureMessage | undefined {
  const fixture = getStoredMessageAsFixture(peerKey, messageId, recipientUserId);
  if (!fixture) return undefined;
  fixture.out = false;
  fixture.fromPeerKey = `user:${senderUserId}`;
  return fixture;
}

export function getStoredMessageAsFixture(peerKey: string, messageId: number, selfId?: number): FixtureMessage | undefined {
  const effectiveSelfId = selfId ?? SEED_USER_ID;
  const message = messageStore.getMessage(effectiveSelfId, peerKey, messageId);
  if (!message) {
    return undefined;
  }

  const isSavedMessages = peerKey === `user:${effectiveSelfId}`;
  return {
    id: message.messageId,
    peerKey: message.peerKey,
    date: message.date,
    text: message.text,
    className: message.actionType ? 'MessageService' : 'Message',
    out: isSavedMessages ? false : message.isOutgoing,
    post: message.post,
    fromPeerKey: isSavedMessages ? undefined : message.fromPeerKey,
    savedPeerKey: isSavedMessages ? `user:${effectiveSelfId}` : undefined,
    editDate: message.editDate,
    replyToMsgId: message.replyToMsgId,
    quoteText: message.quoteText,
    quoteOffset: message.quoteOffset,
    mediaId: message.mediaId,
    fwdFromPeerKey: message.fwdFromPeerKey,
    fwdFromName: message.fwdFromName,
    fwdDate: message.fwdDate,
    action: buildActionForFixture(peerKey, message.actionType, message.text, message.mediaId),
    reactions: getReactionsForMessage(effectiveSelfId, peerKey, message.messageId, effectiveSelfId),
    entities: message.entities,
  };
}

// ========== Merge / sort helpers ==========

export function mergeMessagesById(messages: FixtureMessage[]): FixtureMessage[] {
  const uniqueMessages = new Map<number, FixtureMessage>();
  for (const message of messages) {
    uniqueMessages.set(message.id, message);
  }

  return Array.from(uniqueMessages.values())
    .sort((left, right) => (right.id - left.id) || (right.date - left.date));
}

export function mergeDialogWithMessages(dialog: FixtureDialog, messages: FixtureMessage[]): FixtureDialog {
  const topMessage = messages[0];
  const mergedDialog = !topMessage ? dialog : {
    ...dialog,
    topMessage: topMessage.id,
    readOutboxMaxId: topMessage.out
      ? Math.max(dialog.readOutboxMaxId, topMessage.id)
      : dialog.readOutboxMaxId,
    readInboxMaxId: topMessage.out && dialog.peerKey === `user:${SEED_USER_ID}`
      ? Math.max(dialog.readInboxMaxId, topMessage.id)
      : dialog.readInboxMaxId,
  };

  return applyStoredDialogState(mergedDialog);
}

export function buildTopDialogMessage(peerKey: string, baseMessage?: FixtureMessage): FixtureMessage | undefined {
  const mergedMessages = mergeMessagesById([
    ...(baseMessage ? [baseMessage] : []),
    ...listStoredMessagesAsFixture(peerKey),
  ]);

  return mergedMessages[0];
}

export function createDialogFromMessage(peerKey: string, message: FixtureMessage): FixtureDialog {
  return applyStoredDialogState({
    peerKey,
    topMessage: message.id,
    readInboxMaxId: peerKey === `user:${SEED_USER_ID}` ? message.id : 0,
    readOutboxMaxId: message.out ? message.id : 0,
    unreadCount: 0,
    unreadMentionsCount: 0,
    unreadReactionsCount: 0,
  });
}

export function sliceHistoryMessages(messages: FixtureMessage[], offsetId: number, limit: number): FixtureMessage[] {
  const filteredMessages = offsetId > 0
    ? messages.filter((message) => message.id < offsetId)
    : messages;

  return filteredMessages.slice(0, limit > 0 ? limit : filteredMessages.length);
}

// ========== Collect entity IDs ==========

export function collectChatIdsFromMessages(baseChatIds: string[], messages: FixtureMessage[]): string[] {
  const derivedChatIds = messages
    .filter((message) => message.peerKey.startsWith('channel:') || message.peerKey.startsWith('chat:'))
    .map((message) => message.peerKey.split(':', 2)[1]);

  return Array.from(new Set([...baseChatIds, ...derivedChatIds]));
}

export function collectUserIdsFromMessages(baseUserIds: string[], messages: FixtureMessage[]): string[] {
  const peerUserIds = messages
    .filter((message) => message.peerKey.startsWith('user:'))
    .map((message) => message.peerKey.split(':', 2)[1]);
  const fromUserIds = messages
    .filter((message) => message.fromPeerKey?.startsWith('user:'))
    .map((message) => message.fromPeerKey!.split(':', 2)[1]);

  return Array.from(new Set([...baseUserIds, ...peerUserIds, ...fromUserIds]));
}

export function collectEntityIdsFromPeerKey(peerKey: string, userIds: string[], chatIds: string[]) {
  if (peerKey.startsWith('user:')) {
    userIds.push(peerKey.split(':', 2)[1]);
    return;
  }

  if (peerKey.startsWith('channel:') || peerKey.startsWith('chat:')) {
    chatIds.push(peerKey.split(':', 2)[1]);
  }
}

// ========== Dialog state helpers ==========

export function getReadStateForPeerKey(peerKey: string, selfId: number, fixtureDialog?: FixtureDialog) {
  const stored = messageStore.getPeerState(selfId, peerKey);

  return {
    readInboxMaxId: Math.max(fixtureDialog?.readInboxMaxId || 0, stored?.readInboxMaxId || 0),
    readOutboxMaxId: Math.max(fixtureDialog?.readOutboxMaxId || 0, stored?.readOutboxMaxId || 0),
  };
}

export function applyStoredDialogState(dialog: FixtureDialog, selfId: number = SEED_USER_ID): FixtureDialog {
  const state = messageStore.getPeerState(selfId, dialog.peerKey);
  if (!state) {
    return dialog;
  }

  return {
    ...dialog,
    readInboxMaxId: Math.max(dialog.readInboxMaxId, state.readInboxMaxId),
    readOutboxMaxId: Math.max(dialog.readOutboxMaxId, state.readOutboxMaxId),
  };
}

export function getHighestObservedMessageId(fixture: OfficialCaptureFixture, peerKey: string): number {
  const dialogMax = fixture.dialogs
    .filter((dialog) => dialog.peerKey === peerKey)
    .reduce((max, dialog) => Math.max(max, dialog.topMessage), 0);
  const dialogMessagesMax = fixture.dialogMessages
    .filter((message) => message.peerKey === peerKey)
    .reduce((max, message) => Math.max(max, message.id), 0);
  const historyMessagesMax = Object.values(fixture.historiesByKey)
    .filter((history) => history.peerKey === peerKey)
    .flatMap((history) => history.messages)
    .reduce((max, message) => Math.max(max, message.id), 0);

  return Math.max(dialogMax, dialogMessagesMax, historyMessagesMax);
}

// ========== User lookup ==========

export function getFixtureUserForId(
  fixture: OfficialCaptureFixture | undefined,
  userId: string,
  isSelf?: boolean,
): FixtureUser {
  const fixtureUser = fixture?.usersById[userId];
  if (fixtureUser) {
    return fixtureUser;
  }

  // Look up user in database
  const dbUser = messageStore.getUserById(Number(userId));
  if (dbUser) {
    return {
      id: String(dbUser.id),
      accessHash: dbUser.accessHash.toString(),
      firstName: dbUser.firstName,
      lastName: dbUser.lastName || undefined,
      username: dbUser.username,
      phone: dbUser.phone,
      photoId: dbUser.photoId,
      self: isSelf,
      about: dbUser.about,
      bot: dbUser.bot,
      botInfoVersion: dbUser.botInfoVersion,
      botInlinePlaceholder: dbUser.botInlinePlaceholder,
      botActiveUsers: dbUser.botActiveUsers,
      verified: dbUser.verified,
      restricted: dbUser.restricted,
      scam: dbUser.scam,
      fake: dbUser.fake,
      premium: dbUser.premium,
      langCode: dbUser.langCode,
      emojiStatusDocumentId: dbUser.emojiStatusDocumentId,
      emojiStatusUntil: dbUser.emojiStatusUntil,
      colorId: dbUser.colorId,
      colorBackgroundEmojiId: dbUser.colorBackgroundEmojiId,
      profileColorId: dbUser.profileColorId,
      profileColorBackgroundEmojiId: dbUser.profileColorBackgroundEmojiId,
      birthdayDay: dbUser.birthdayDay,
      birthdayMonth: dbUser.birthdayMonth,
      birthdayYear: dbUser.birthdayYear,
      commonChatsCount: dbUser.commonChatsCount,
      pinnedMsgId: dbUser.pinnedMsgId,
      phoneCallsAvailable: dbUser.phoneCallsAvailable,
      phoneCallsPrivate: dbUser.phoneCallsPrivate,
      videoCallsAvailable: dbUser.videoCallsAvailable,
      voiceMessagesForbidden: dbUser.voiceMessagesForbidden,
      privateForwardName: dbUser.privateForwardName,
      ttlPeriod: dbUser.ttlPeriod,
      themeEmoticon: dbUser.themeEmoticon,
      contactRequirePremium: dbUser.contactRequirePremium,
      personalChannelId: dbUser.personalChannelId,
      personalChannelMessage: dbUser.personalChannelMessage,
      stargiftsCount: dbUser.stargiftsCount,
    };
  }

  return {
    id: userId,
    accessHash: '0',
    firstName: 'User',
  };
}
