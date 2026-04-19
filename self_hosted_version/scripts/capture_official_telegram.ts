import BetterSqlite3 from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import WebSocket from 'ws';

import { initDatabase } from '../src/database/schema.js';
import {
  createRawCaptureRun,
  initRawCaptureSchema,
  insertRawCapture,
} from '../src/database/rawCapture.js';

type SessionData = {
  mainDcId: number;
  keys: Record<number, string>;
  isTest?: true;
  serverConfigScope?: string;
};

type CaptureOptions = {
  sessionFile: string;
  outputDir: string;
  dbPath: string;
  dialogsLimit: number;
  histories: number;
  historyLimit: number;
  accountLabel?: string;
  captureGroupCreate?: string;  // title for test group, if provided
  captureChannelCreate?: string; // title for test supergroup, if provided
};

type TlLike = {
  CONSTRUCTOR_ID?: number;
  className?: string;
  classType?: string;
  [key: string]: unknown;
};

const DEFAULT_DIALOGS_LIMIT = 20;
const DEFAULT_HISTORIES = 5;
const DEFAULT_HISTORY_LIMIT = 30;
const DEFAULT_OUTPUT_DIR = resolve(process.cwd(), 'captures', 'official');
const DEFAULT_DB_PATH = resolve(process.cwd(), 'data', 'telegram_observations.sqlite');
const OFFICIAL_WEB_API_ID = 2496;
const OFFICIAL_WEB_API_HASH = '8da85b0d5bfe62527e5b244c209159c3';

async function main() {
  const options = parseArgs(process.argv.slice(2));

  ensureDir(options.outputDir);
  ensureDir(dirname(options.dbPath));

  installNodePolyfills();

  const { Api, TelegramClient, sessions } = await import('../../web_client/src/lib/gramjs/index.ts');
  const { setServerConfig } = await import('../../web_client/src/lib/gramjs/Utils.ts');
  const sessionData = readSessionData(options.sessionFile);
  const session = new sessions.CallbackSession(sessionData, () => {});

  setServerConfig({
    profileId: 'telegram-official',
    defaultDcId: sessionData.mainDcId,
    hostPattern: 'zws{dcId}.web.telegram.org',
    port: 443,
  } as any);

  const client = new TelegramClient(
    session,
    OFFICIAL_WEB_API_ID,
    OFFICIAL_WEB_API_HASH,
    {
      deviceModel: `Codex Capture (${process.platform})`,
      systemVersion: `Node ${process.version}`,
      appVersion: 'Codex Telegram Capture',
      langCode: 'en',
      systemLangCode: 'en',
      langPack: 'weba',
      useWSS: true,
      additionalDcsDisabled: false,
      shouldForceHttpTransport: false,
      shouldAllowHttpTransport: false,
    } as any,
  );

  const db = initDatabase(options.dbPath) as BetterSqlite3.Database;
  initRawCaptureSchema(db);

  const runId = createRawCaptureRun(db, {
    source: 'official_telegram',
    accountLabel: options.accountLabel,
    sessionMainDcId: sessionData.mainDcId,
    sessionIsTest: Boolean(sessionData.isTest),
    notes: `dialogsLimit=${options.dialogsLimit}; histories=${options.histories}; historyLimit=${options.historyLimit}`,
  });

  const runOutput = {
    runId,
    createdAt: new Date().toISOString(),
    sessionMainDcId: sessionData.mainDcId,
    sessionIsTest: Boolean(sessionData.isTest),
    captures: [] as unknown[],
  };

  try {
    await client.connect();

    const capture = async (
      method: string,
      request: TlLike,
      scope?: string,
      peerKey?: string,
    ) => {
      const response = await client.invoke(request as any);
      const requestJson = JSON.stringify(serializeTl(request), null, 2);
      const responseJsonObject = serializeTl(response);
      const responseJson = JSON.stringify(responseJsonObject, null, 2);

      insertRawCapture(db, {
        runId,
        method,
        scope,
        peerKey,
        requestJson,
        responseJson,
        responseClassName: getClassName(response),
        responseConstructorId: getConstructorId(response),
      });

      runOutput.captures.push({
        method,
        scope,
        peerKey,
        request: JSON.parse(requestJson),
        response: responseJsonObject,
      });

      return response as TlLike;
    };

    await capture('help.getConfig', new Api.help.GetConfig(), 'bootstrap');
    await capture('updates.getState', new Api.updates.GetState(), 'bootstrap');
    await capture(
      'users.getFullUser',
      new Api.users.GetFullUser({ id: new Api.InputUserSelf() }),
      'bootstrap',
      'self',
    );
    await capture('messages.getDialogFilters', new Api.messages.GetDialogFilters(), 'bootstrap');
    await capture(
      'messages.getDialogs',
      new Api.messages.GetDialogs({
        offsetDate: 0,
        offsetId: 0,
        offsetPeer: new Api.InputPeerEmpty(),
        limit: options.dialogsLimit,
        hash: BigInt(0),
      }),
      'bootstrap',
    );
    await capture('messages.getPinnedDialogs', new Api.messages.GetPinnedDialogs(), 'bootstrap');
    await capture(
      'messages.getSavedDialogs',
      new Api.messages.GetSavedDialogs({
        offsetDate: 0,
        offsetId: 0,
        offsetPeer: new Api.InputPeerEmpty(),
        limit: options.dialogsLimit,
        hash: BigInt(0),
      }),
      'bootstrap',
    );
    await capture('messages.getPinnedSavedDialogs', new Api.messages.GetPinnedSavedDialogs(), 'bootstrap');

    const dialogsResponse = await client.invoke(new Api.messages.GetDialogs({
      offsetDate: 0,
      offsetId: 0,
      offsetPeer: new Api.InputPeerEmpty(),
      limit: options.dialogsLimit,
      hash: BigInt(0),
    }));

    const dialogs = Array.isArray((dialogsResponse as any).dialogs)
      ? (dialogsResponse as any).dialogs
      : [];
    const users = Array.isArray((dialogsResponse as any).users)
      ? (dialogsResponse as any).users
      : [];
    const chats = Array.isArray((dialogsResponse as any).chats)
      ? (dialogsResponse as any).chats
      : [];

    for (const dialog of dialogs.slice(0, options.histories)) {
      const inputPeer = buildInputPeer(Api, dialog.peer, users, chats);
      if (!inputPeer) {
        continue;
      }

      const peerKey = buildPeerKey(dialog.peer);

      await capture(
        'messages.getPeerDialogs',
        new Api.messages.GetPeerDialogs({ peers: [inputPeer] }),
        'history_probe',
        peerKey,
      );

      await capture(
        'messages.getHistory',
        new Api.messages.GetHistory({
          peer: inputPeer,
          offsetId: 0,
          offsetDate: 0,
          addOffset: 0,
          limit: options.historyLimit,
          maxId: 0,
          minId: 0,
          hash: BigInt(0),
        }),
        'history_probe',
        peerKey,
      );
    }

    // ── Optional: capture group-creation cycle ─────────────────────────────
    if (options.captureGroupCreate) {
      const groupTitle = options.captureGroupCreate;
      // eslint-disable-next-line no-console
      console.log(`\n[capture] Creating test group "${groupTitle}"...`);

      const createResult = await capture(
        'messages.createChat',
        new Api.messages.CreateChat({
          users: [new Api.InputUserSelf()],
          title: groupTitle,
        }),
        'group_create',
      );

      // Extract chatId from the Updates response
      let chatId: bigint | number | undefined;
      const createdChats: TlLike[] = Array.isArray((createResult as any)?.chats)
        ? (createResult as any).chats
        : [];
      if (createdChats.length > 0) {
        chatId = createdChats[0].id as bigint | number;
      }

      if (chatId !== undefined) {
        const chatPeer = new Api.InputPeerChat({ chatId });

        await capture(
          'messages.getFullChat',
          new Api.messages.GetFullChat({ chatId }),
          'group_create',
          `chat:${String(chatId)}`,
        );

        await capture(
          'messages.getPeerDialogs',
          new Api.messages.GetPeerDialogs({ peers: [chatPeer] }),
          'group_create',
          `chat:${String(chatId)}`,
        );

        await capture(
          'messages.getHistory',
          new Api.messages.GetHistory({
            peer: chatPeer,
            offsetId: 0,
            offsetDate: 0,
            addOffset: 0,
            limit: 10,
            maxId: 0,
            minId: 0,
            hash: BigInt(0),
          }),
          'group_create',
          `chat:${String(chatId)}`,
        );

        // Fetch msgId=1 explicitly (the service message)
        await capture(
          'messages.getMessages#id=1',
          new Api.messages.GetMessages({
            id: [new Api.InputMessageID({ id: 1 })],
          }),
          'group_create',
          `chat:${String(chatId)}`,
        );

        // Clean up
        // eslint-disable-next-line no-console
        console.log(`[capture] Deleting test group chat:${String(chatId)}...`);
        try {
          await client.invoke(new Api.messages.DeleteChat({ chatId }));
          // eslint-disable-next-line no-console
          console.log('[capture] Test group deleted.');
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[capture] Could not delete test group:', (e as Error).message);
        }
      } else {
        // eslint-disable-next-line no-console
        console.warn('[capture] Could not determine chatId from createChat response.');
      }
    }

    // ── Optional: capture supergroup-creation cycle ────────────────────────
    if (options.captureChannelCreate) {
      const channelTitle = options.captureChannelCreate;
      // eslint-disable-next-line no-console
      console.log(`\n[capture] Creating test supergroup "${channelTitle}"...`);

      const createResult = await capture(
        'channels.createChannel',
        new Api.channels.CreateChannel({
          title: channelTitle,
          about: '',
          megagroup: true,
        }),
        'channel_create',
      );

      const createdChats: TlLike[] = Array.isArray((createResult as any)?.chats)
        ? (createResult as any).chats
        : [];
      let channelId: bigint | number | undefined;
      let accessHash: bigint | undefined;
      if (createdChats.length > 0) {
        channelId = createdChats[0].id as bigint | number;
        accessHash = createdChats[0].accessHash as bigint;
      }

      if (channelId !== undefined && accessHash !== undefined) {
        const channelInput = new Api.InputChannel({ channelId, accessHash });
        const channelPeer = new Api.InputPeerChannel({ channelId, accessHash });

        await capture(
          'channels.getFullChannel',
          new Api.channels.GetFullChannel({ channel: channelInput }),
          'channel_create',
          `channel:${String(channelId)}`,
        );

        await capture(
          'messages.getPeerDialogs',
          new Api.messages.GetPeerDialogs({ peers: [channelPeer] }),
          'channel_create',
          `channel:${String(channelId)}`,
        );

        await capture(
          'messages.getHistory',
          new Api.messages.GetHistory({
            peer: channelPeer,
            offsetId: 0,
            offsetDate: 0,
            addOffset: 0,
            limit: 10,
            maxId: 0,
            minId: 0,
            hash: BigInt(0),
          }),
          'channel_create',
          `channel:${String(channelId)}`,
        );

        // Clean up
        // eslint-disable-next-line no-console
        console.log(`[capture] Deleting test channel channel:${String(channelId)}...`);
        try {
          await client.invoke(new Api.channels.DeleteChannel({ channel: channelInput }));
          // eslint-disable-next-line no-console
          console.log('[capture] Test channel deleted.');
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[capture] Could not delete test channel:', (e as Error).message);
        }
      } else {
        // eslint-disable-next-line no-console
        console.warn('[capture] Could not determine channelId from createChannel response.');
      }
    }
  } finally {
    writeFileSync(
      resolve(options.outputDir, `run-${runId}.json`),
      JSON.stringify(runOutput, null, 2),
    );
    client.destroy();
    db.close();
  }

  // eslint-disable-next-line no-console
  console.log(`Captured official Telegram payloads into ${options.dbPath} and ${options.outputDir}`);
}

function parseArgs(argv: string[]): CaptureOptions {
  const values = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      values.set(key, 'true');
      continue;
    }

    values.set(key, value);
    i += 1;
  }

  const sessionFile = values.get('session-file');
  if (!sessionFile) {
    throw new Error('Missing required --session-file /absolute/path/to/session.json');
  }

  return {
    sessionFile: resolve(sessionFile),
    outputDir: resolve(values.get('output-dir') || DEFAULT_OUTPUT_DIR),
    dbPath: resolve(values.get('db-path') || DEFAULT_DB_PATH),
    dialogsLimit: parsePositiveInt(values.get('dialogs-limit'), DEFAULT_DIALOGS_LIMIT),
    histories: parsePositiveInt(values.get('histories'), DEFAULT_HISTORIES),
    historyLimit: parsePositiveInt(values.get('history-limit'), DEFAULT_HISTORY_LIMIT),
    accountLabel: values.get('account-label') || undefined,
    captureGroupCreate: values.get('capture-group-create') || undefined,
    captureChannelCreate: values.get('capture-channel-create') || undefined,
  };
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function ensureDir(path: string) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function readSessionData(path: string): SessionData {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as SessionData;
  if (!parsed?.mainDcId || !parsed.keys || typeof parsed.keys !== 'object') {
    throw new Error(`Invalid session data in ${path}`);
  }

  return parsed;
}

function installNodePolyfills() {
  const globalScope = globalThis as typeof globalThis & {
    self?: typeof globalThis & { addEventListener?: (type: string, cb: (...args: unknown[]) => void) => void };
    navigator?: Navigator & {
      locks?: { request: <T>(name: string, callback: () => Promise<T>) => Promise<T> };
      userAgent?: string;
      language?: string;
    };
    WebSocket?: typeof WebSocket;
  };

  if (!globalScope.self) {
    globalScope.self = globalScope;
  }

  if (typeof globalScope.self.addEventListener !== 'function') {
    globalScope.self.addEventListener = () => {};
  }

  if (!globalScope.WebSocket) {
    globalScope.WebSocket = WebSocket;
  }

  if (!globalScope.navigator) {
    Object.defineProperty(globalScope, 'navigator', {
      value: {
        userAgent: `Node ${process.version}`,
        language: 'en',
      },
      configurable: true,
    });
  }

  if (!globalScope.navigator.userAgent) {
    Object.defineProperty(globalScope.navigator, 'userAgent', {
      value: `Node ${process.version}`,
      configurable: true,
    });
  }

  if (!globalScope.navigator.language) {
    Object.defineProperty(globalScope.navigator, 'language', {
      value: 'en',
      configurable: true,
    });
  }

  if (!globalScope.navigator.locks) {
    Object.defineProperty(globalScope.navigator, 'locks', {
      value: {
        request: async <T>(_name: string, callback: () => Promise<T>) => callback(),
      },
      configurable: true,
    });
  }
}

function buildInputPeer(Api: any, peer: TlLike, users: TlLike[], chats: TlLike[]) {
  if (!peer?.className) {
    return undefined;
  }

  if (peer.className === 'PeerUser') {
    const user = users.find((entity) => entity.className === 'User' && entity.id === peer.userId);
    if (!user || typeof user.accessHash !== 'bigint') {
      return undefined;
    }

    return new Api.InputPeerUser({
      userId: user.id,
      accessHash: user.accessHash,
    });
  }

  if (peer.className === 'PeerChat') {
    return new Api.InputPeerChat({
      chatId: peer.chatId,
    });
  }

  if (peer.className === 'PeerChannel') {
    const chat = chats.find((entity) => (
      (entity.className === 'Channel' || entity.className === 'ChannelForbidden')
      && entity.id === peer.channelId
    ));

    if (!chat || typeof chat.accessHash !== 'bigint') {
      return undefined;
    }

    return new Api.InputPeerChannel({
      channelId: chat.id,
      accessHash: chat.accessHash,
    });
  }

  return undefined;
}

function buildPeerKey(peer: TlLike) {
  if (peer.className === 'PeerUser') {
    return `user:${String(peer.userId)}`;
  }

  if (peer.className === 'PeerChat') {
    return `chat:${String(peer.chatId)}`;
  }

  if (peer.className === 'PeerChannel') {
    return `channel:${String(peer.channelId)}`;
  }

  return 'unknown';
}

function serializeTl(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return {
      __type: 'Buffer',
      hex: value.toString('hex'),
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeTl(item, seen));
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  const objectValue = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  if (typeof objectValue.className === 'string') {
    output.__className = objectValue.className;
  }
  if (typeof objectValue.classType === 'string') {
    output.__classType = objectValue.classType;
  }
  if (typeof objectValue.CONSTRUCTOR_ID === 'number') {
    output.__constructorId = objectValue.CONSTRUCTOR_ID >>> 0;
  }

  for (const [key, nestedValue] of Object.entries(objectValue)) {
    if (typeof nestedValue === 'function') {
      continue;
    }
    output[key] = serializeTl(nestedValue, seen);
  }

  return output;
}

function getClassName(value: unknown) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const typed = value as TlLike;
  return typeof typed.className === 'string' ? typed.className : undefined;
}

function getConstructorId(value: unknown) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const typed = value as TlLike;
  return typeof typed.CONSTRUCTOR_ID === 'number' ? (typed.CONSTRUCTOR_ID >>> 0) : undefined;
}

void main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
