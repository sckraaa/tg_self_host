import { existsSync, readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type CaptureItem = {
  method: string;
  peerKey?: string;
  response: JsonValue;
};

type CaptureRun = {
  captures: CaptureItem[];
};

export interface FixtureUser {
  id: string;
  accessHash?: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  phone?: string;
  photoId?: number;
  self?: boolean;
  contact?: boolean;
  // Extended fields (matching real Telegram User + UserFull)
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

export interface FixtureDialog {
  peerKey: string;
  topMessage: number;
  readInboxMaxId: number;
  readOutboxMaxId: number;
  unreadCount: number;
  unreadMentionsCount: number;
  unreadReactionsCount: number;
  pts?: number;
  draftDate?: number;
}

export interface FixtureMessage {
  id: number;
  peerKey: string;
  date: number;
  text: string;
  className: string;
  out?: boolean;
  post?: boolean;
  fromPeerKey?: string;
  savedPeerKey?: string;
  editDate?: number;
  replyToMsgId?: number;
  quoteText?: string;
  quoteOffset?: number;
  mediaId?: number;
  fwdFromPeerKey?: string;
  fwdFromName?: string;
  fwdDate?: number;
  action?: {
    type: 'chatCreate' | 'channelCreate' | 'chatEditPhoto' | 'chatDeleteUser' | 'phoneCall';
    title: string;
    userIds?: number[];
    photoId?: number;
    userId?: number;
    // phoneCall specific
    callId?: string;
    duration?: number;
    reason?: string;
    isVideo?: boolean;
  };
  reactions?: Array<{ emoticon: string; count: number; chosenOrder?: number }>;
  /**
   * Serialized `Vector<MessageEntity>` buffer (audit #2). When set, it is written
   * verbatim into the TL stream with flag 7, preserving bold/italic/links/mentions.
   */
  entities?: Buffer;
}

export interface FixtureHistory {
  responseClassName: string;
  count?: number;
  pts?: number;
  peerKey: string;
  messages: FixtureMessage[];
  userIds: string[];
  chatIds: string[];
}

export interface FixtureChat {
  id: string;
  peerKey: string;
  className: 'Channel';
  accessHash?: string;
  title: string;
  username?: string;
  date: number;
  creator?: boolean;
  broadcast?: boolean;
}

export interface OfficialCaptureFixture {
  sourcePath: string;
  dialogsCount: number;
  dialogs: FixtureDialog[];
  dialogMessages: FixtureMessage[];
  dialogUserIds: string[];
  dialogChatIds: string[];
  peerDialogsByKey: Record<string, {
    dialogs: FixtureDialog[];
    messages: FixtureMessage[];
    userIds: string[];
    chatIds: string[];
  }>;
  historiesByKey: Record<string, FixtureHistory>;
  usersById: Record<string, FixtureUser>;
  chatsById: Record<string, FixtureChat>;
}

let cachedFixture: OfficialCaptureFixture | null | undefined;

export function getOfficialCaptureFixture(seedUserId: number): OfficialCaptureFixture | undefined {
  if (cachedFixture !== undefined) {
    return cachedFixture || undefined;
  }

  const sourcePath = resolveFixturePath();
  if (!sourcePath) {
    cachedFixture = null;
    return undefined;
  }

  const run = JSON.parse(readFileSync(sourcePath, 'utf8')) as CaptureRun;
  const fixture = buildFixtureFromRun(run, sourcePath, String(seedUserId));
  cachedFixture = fixture || null;
  return fixture || undefined;
}

function resolveFixturePath() {
  const explicit = process.env.TELEGRAM_CAPTURE_RUN_PATH;
  if (explicit && existsSync(resolve(explicit))) {
    return resolve(explicit);
  }

  const candidateDirs = [
    resolve(process.cwd(), 'captures', 'official'),
    resolve(process.cwd(), 'self_hosted_version', 'captures', 'official'),
  ];

  for (const dir of candidateDirs) {
    if (!existsSync(dir)) {
      continue;
    }

    const latest = readdirSync(dir)
      .filter((fileName) => /^run-\d+\.json$/.test(fileName))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
      .at(-1);

    if (latest) {
      return resolve(dir, latest);
    }
  }

  return undefined;
}

function buildFixtureFromRun(run: CaptureRun, sourcePath: string, seedUserId: string): OfficialCaptureFixture | undefined {
  const dialogCapture = run.captures.find((capture) => capture.method === 'messages.getDialogs' && isObject(capture.response));
  if (!dialogCapture || !isObject(dialogCapture.response)) {
    return undefined;
  }

  const selfUserId = findSelfUserId(run);
  const usersById: Record<string, FixtureUser> = {};
  const chatsById: Record<string, FixtureChat> = {};

  for (const capture of run.captures) {
    if (!isObject(capture.response) || !Array.isArray(capture.response.users)) {
      // continue with chats below
    } else {
      for (const user of capture.response.users.filter(isObject)) {
        const mappedUser = extractUser(user, selfUserId, seedUserId);
        usersById[mappedUser.id] = {
          ...usersById[mappedUser.id],
          ...mappedUser,
        };
      }
    }

    if (!isObject(capture.response) || !Array.isArray(capture.response.chats)) {
      continue;
    }

    for (const chat of capture.response.chats.filter(isObject)) {
      const mappedChat = extractChat(chat);
      if (!mappedChat) {
        continue;
      }

      chatsById[mappedChat.id] = {
        ...chatsById[mappedChat.id],
        ...mappedChat,
      };
    }
  }

  const peerDialogsByKey: OfficialCaptureFixture['peerDialogsByKey'] = {};
  const historiesByKey: OfficialCaptureFixture['historiesByKey'] = {};

  for (const capture of run.captures) {
    if (!capture.peerKey || !isObject(capture.response)) {
      continue;
    }

    if (capture.method === 'messages.getPeerDialogs') {
      if (!isSupportedPeerKey(capture.peerKey)) {
        continue;
      }
      const remappedPeerKey = remapPeerKey(capture.peerKey, selfUserId, seedUserId);
      peerDialogsByKey[remappedPeerKey] = {
        dialogs: extractDialogs(capture.response.dialogs, selfUserId, seedUserId),
        messages: extractMessages(capture.response.messages, selfUserId, seedUserId),
        userIds: extractUserIds(capture.response.users, selfUserId, seedUserId),
        chatIds: extractChatIds(capture.response.chats),
      };
    }

    if (capture.method === 'messages.getHistory') {
      if (!isSupportedPeerKey(capture.peerKey)) {
        continue;
      }
      const remappedPeerKey = remapPeerKey(capture.peerKey, selfUserId, seedUserId);
      historiesByKey[remappedPeerKey] = {
        responseClassName: typeof capture.response.className === 'string'
          ? capture.response.className
          : 'messages.MessagesSlice',
        count: typeof capture.response.count === 'number' ? capture.response.count : undefined,
        pts: typeof capture.response.pts === 'number' ? capture.response.pts : undefined,
        peerKey: remappedPeerKey,
        messages: extractMessages(capture.response.messages, selfUserId, seedUserId),
        userIds: extractUserIds(capture.response.users, selfUserId, seedUserId),
        chatIds: extractChatIds(capture.response.chats),
      };
    }
  }

  return {
    sourcePath,
    dialogsCount: typeof dialogCapture.response.count === 'number'
      ? dialogCapture.response.count
      : Array.isArray(dialogCapture.response.dialogs)
        ? dialogCapture.response.dialogs.length
        : 0,
    dialogs: extractDialogs(dialogCapture.response.dialogs, selfUserId, seedUserId),
    dialogMessages: extractMessages(dialogCapture.response.messages, selfUserId, seedUserId),
    dialogUserIds: extractUserIds(dialogCapture.response.users, selfUserId, seedUserId),
    dialogChatIds: extractChatIds(dialogCapture.response.chats),
    peerDialogsByKey,
    historiesByKey,
    usersById,
    chatsById,
  };
}

function findSelfUserId(run: CaptureRun) {
  for (const capture of run.captures) {
    if (!isObject(capture.response) || !Array.isArray(capture.response.users)) {
      continue;
    }

    for (const user of capture.response.users.filter(isObject)) {
      if (user.self === true && user.id !== undefined) {
        return String(user.id);
      }
    }
  }

  return undefined;
}

function extractUser(user: Record<string, JsonValue>, selfUserId: string | undefined, seedUserId: string): FixtureUser {
  const rawId = user.id !== undefined ? String(user.id) : seedUserId;
  const id = rawId === selfUserId ? seedUserId : rawId;

  return {
    id,
    accessHash: typeof user.accessHash === 'string' ? user.accessHash : undefined,
    firstName: typeof user.firstName === 'string' ? user.firstName : undefined,
    username: typeof user.username === 'string' ? user.username : undefined,
    phone: typeof user.phone === 'string' ? user.phone : undefined,
    self: rawId === selfUserId ? true : user.self === true,
  };
}

function extractDialogs(value: JsonValue | undefined, selfUserId: string | undefined, seedUserId: string): FixtureDialog[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isObject)
    .map((dialog) => ({
      peerKey: remapPeerKey(normalizePeer(dialog.peer) || '', selfUserId, seedUserId),
      topMessage: typeof dialog.topMessage === 'number' ? dialog.topMessage : 0,
      readInboxMaxId: typeof dialog.readInboxMaxId === 'number' ? dialog.readInboxMaxId : 0,
      readOutboxMaxId: typeof dialog.readOutboxMaxId === 'number' ? dialog.readOutboxMaxId : 0,
      unreadCount: typeof dialog.unreadCount === 'number' ? dialog.unreadCount : 0,
      unreadMentionsCount: typeof dialog.unreadMentionsCount === 'number' ? dialog.unreadMentionsCount : 0,
      unreadReactionsCount: typeof dialog.unreadReactionsCount === 'number' ? dialog.unreadReactionsCount : 0,
      pts: typeof dialog.pts === 'number' ? dialog.pts : undefined,
      draftDate: isObject(dialog.draft) && typeof dialog.draft.date === 'number' ? dialog.draft.date : undefined,
    }))
    .filter((dialog) => isSupportedPeerKey(dialog.peerKey));
}

function extractMessages(value: JsonValue | undefined, selfUserId: string | undefined, seedUserId: string): FixtureMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isObject)
    .filter((message) => message.className === 'Message')
    .map((message) => ({
      id: typeof message.id === 'number' ? message.id : 0,
      peerKey: remapPeerKey(normalizePeer(message.peerId) || '', selfUserId, seedUserId),
      date: typeof message.date === 'number' ? message.date : 0,
      text: typeof message.message === 'string' ? message.message : '',
      className: typeof message.className === 'string' ? message.className : 'Message',
      out: message.out === true,
      post: message.post === true,
      fromPeerKey: remapPeerKey(normalizePeer(message.fromId) || '', selfUserId, seedUserId),
    }))
    .filter((message) => message.id > 0 && isSupportedPeerKey(message.peerKey));
}

function extractUserIds(value: JsonValue | undefined, selfUserId: string | undefined, seedUserId: string) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isObject)
    .map((user) => {
      const rawId = user.id !== undefined ? String(user.id) : undefined;
      if (!rawId) {
        return undefined;
      }

      return rawId === selfUserId ? seedUserId : rawId;
    })
    .filter((userId): userId is string => Boolean(userId));
}

function extractChatIds(value: JsonValue | undefined) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isObject)
    .map((chat) => chat.id !== undefined ? String(chat.id) : undefined)
    .filter((chatId): chatId is string => Boolean(chatId));
}

function extractChat(chat: Record<string, JsonValue>): FixtureChat | undefined {
  if (chat.className !== 'Channel' || chat.id === undefined || typeof chat.title !== 'string') {
    return undefined;
  }

  return {
    id: String(chat.id),
    peerKey: `channel:${String(chat.id)}`,
    className: 'Channel',
    accessHash: typeof chat.accessHash === 'string' ? chat.accessHash : undefined,
    title: chat.title,
    username: typeof chat.username === 'string' ? chat.username : undefined,
    date: typeof chat.date === 'number' ? chat.date : 0,
    creator: chat.creator === true,
    broadcast: chat.broadcast === true,
  };
}

function normalizePeer(value: JsonValue | undefined) {
  if (!isObject(value) || typeof value.className !== 'string') {
    return undefined;
  }

  if (value.className === 'PeerUser' && value.userId !== undefined) {
    return `user:${String(value.userId)}`;
  }
  if (value.className === 'PeerChat' && value.chatId !== undefined) {
    return `chat:${String(value.chatId)}`;
  }
  if (value.className === 'PeerChannel' && value.channelId !== undefined) {
    return `channel:${String(value.channelId)}`;
  }

  return undefined;
}

function remapPeerKey(peerKey: string, selfUserId: string | undefined, seedUserId: string) {
  if (!selfUserId || !peerKey.endsWith(`:${selfUserId}`)) {
    return peerKey;
  }

  return `${peerKey.split(':', 1)[0]}:${seedUserId}`;
}

function isSupportedPeerKey(peerKey: string) {
  return peerKey.startsWith('user:') || peerKey.startsWith('channel:');
}

function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
