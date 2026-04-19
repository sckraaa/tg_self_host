/**
 * Capture test fixtures from official Telegram servers.
 *
 * This script captures real API responses and saves them as individual JSON files
 * organized by method name. These fixtures become the "golden standard" for
 * validating our self-hosted server responses.
 *
 * Usage:
 *   node --import tsx scripts/capture_test_fixtures.ts --session-file /path/to/session.json
 *
 * Optional flags:
 *   --target-user <username>    Username of a real user to test P2P messaging with (REQUIRED for mutation tests)
 *   --target-channel <username> Username of a channel/supergroup you admin (for channel tests)
 *   --skip-mutations            Skip send/edit/delete tests (read-only capture)
 *   --output-dir <path>         Output directory (default: captures/test-fixtures)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import WebSocket from 'ws';

type SessionData = {
  mainDcId: number;
  keys: Record<number, string>;
  isTest?: true;
};

type CaptureOptions = {
  sessionFile: string;
  outputDir: string;
  targetUser?: string;
  targetChannel?: string;
  skipMutations: boolean;
};

type TlLike = {
  CONSTRUCTOR_ID?: number;
  className?: string;
  classType?: string;
  [key: string]: unknown;
};

const OFFICIAL_WEB_API_ID = 2496;
const OFFICIAL_WEB_API_HASH = '8da85b0d5bfe62527e5b244c209159c3';
const DEFAULT_OUTPUT_DIR = resolve(process.cwd(), 'captures', 'test-fixtures');

// ─── Helpers ────────────────────────────────────────────────────────

function ensureDir(path: string) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function readSessionData(path: string): SessionData {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as SessionData;
  if (!parsed?.mainDcId || !parsed.keys || typeof parsed.keys !== 'object') {
    throw new Error(`Invalid session data in ${path}`);
  }
  return parsed;
}

function serializeTl(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Buffer.isBuffer(value)) return { __type: 'Buffer', hex: value.toString('hex') };
  if (Array.isArray(value)) return value.map((item) => serializeTl(item, seen));
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  const objectValue = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  if (typeof objectValue.className === 'string') output.__className = objectValue.className;
  if (typeof objectValue.classType === 'string') output.__classType = objectValue.classType;
  if (typeof objectValue.CONSTRUCTOR_ID === 'number') {
    output.__constructorId = objectValue.CONSTRUCTOR_ID >>> 0;
  }
  for (const [key, nestedValue] of Object.entries(objectValue)) {
    if (typeof nestedValue === 'function') continue;
    output[key] = serializeTl(nestedValue, seen);
  }
  return output;
}

function installNodePolyfills() {
  const globalScope = globalThis as any;
  if (!globalScope.self) globalScope.self = globalScope;
  if (typeof globalScope.self.addEventListener !== 'function') {
    globalScope.self.addEventListener = () => {};
  }
  if (!globalScope.WebSocket) globalScope.WebSocket = WebSocket;
  if (!globalScope.navigator) {
    Object.defineProperty(globalScope, 'navigator', {
      value: { userAgent: `Node ${process.version}`, language: 'en' },
      configurable: true,
    });
  }
  if (!globalScope.navigator.userAgent) {
    Object.defineProperty(globalScope.navigator, 'userAgent', { value: `Node ${process.version}`, configurable: true });
  }
  if (!globalScope.navigator.language) {
    Object.defineProperty(globalScope.navigator, 'language', { value: 'en', configurable: true });
  }
  if (!globalScope.navigator.locks) {
    Object.defineProperty(globalScope.navigator, 'locks', {
      value: { request: async <T>(_name: string, callback: () => Promise<T>) => callback() },
      configurable: true,
    });
  }
}

function parseArgs(argv: string[]): CaptureOptions {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      values.set(key, 'true');
      continue;
    }
    values.set(key, value);
    i++;
  }

  const sessionFile = values.get('session-file');
  if (!sessionFile) throw new Error('Missing --session-file');

  return {
    sessionFile: resolve(sessionFile),
    outputDir: resolve(values.get('output-dir') || DEFAULT_OUTPUT_DIR),
    targetUser: values.get('target-user'),
    targetChannel: values.get('target-channel'),
    skipMutations: values.has('skip-mutations'),
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const options = parseArgs(process.argv.slice(2));
  ensureDir(options.outputDir);
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
      deviceModel: `Fixture Capture (${process.platform})`,
      systemVersion: `Node ${process.version}`,
      appVersion: 'Test Fixture Capture',
      langCode: 'en',
      systemLangCode: 'en',
      langPack: 'weba',
      useWSS: true,
      additionalDcsDisabled: false,
      shouldForceHttpTransport: false,
      shouldAllowHttpTransport: false,
    } as any,
  );

  const fixtures: Record<string, unknown> = {};
  let fixtureCount = 0;

  const capture = async (name: string, request: TlLike, extra?: Record<string, unknown>) => {
    console.log(`  [${++fixtureCount}] Capturing: ${name}...`);
    try {
      const response = await client.invoke(request as any);
      const data = {
        method: name,
        capturedAt: new Date().toISOString(),
        request: serializeTl(request),
        response: serializeTl(response),
        ...(extra || {}),
      };
      fixtures[name] = data;

      // Save individual file
      const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
      writeFileSync(
        resolve(options.outputDir, `${safeName}.json`),
        JSON.stringify(data, null, 2),
      );
      return response as TlLike;
    } catch (e) {
      console.error(`  [ERROR] ${name}: ${(e as Error).message}`);
      fixtures[name] = {
        method: name,
        capturedAt: new Date().toISOString(),
        error: (e as Error).message,
      };
      return undefined;
    }
  };

  try {
    await client.connect();
    console.log('\n=== Connected to official Telegram ===\n');

    // ─────────────────────────────────────────────────────────────
    // GROUP 1: Read-only API responses (structure fixtures)
    // ─────────────────────────────────────────────────────────────
    console.log('── Group 1: Read-only fixtures ──');

    await capture('help.getConfig', new Api.help.GetConfig());

    await capture('updates.getState', new Api.updates.GetState());

    await capture('users.getFullUser__self', new Api.users.GetFullUser({
      id: new Api.InputUserSelf(),
    }));

    await capture('users.getUsers__self', new Api.users.GetUsers({
      id: [new Api.InputUserSelf()],
    }));

    // Dialogs
    const dialogsResp = await capture('messages.getDialogs', new Api.messages.GetDialogs({
      offsetDate: 0,
      offsetId: 0,
      offsetPeer: new Api.InputPeerEmpty(),
      limit: 20,
      hash: BigInt(0),
    }));

    await capture('messages.getPinnedDialogs', new Api.messages.GetPinnedDialogs());

    await capture('messages.getDialogFilters', new Api.messages.GetDialogFilters());

    // Contacts
    await capture('contacts.getContacts', new Api.contacts.GetContacts({
      hash: BigInt(0),
    }));

    await capture('contacts.search__test', new Api.contacts.Search({
      q: 'telegram',
      limit: 10,
    }));

    // History for first few dialog peers
    if (dialogsResp) {
      const dialogs = Array.isArray((dialogsResp as any).dialogs) ? (dialogsResp as any).dialogs : [];
      const users = Array.isArray((dialogsResp as any).users) ? (dialogsResp as any).users : [];
      const chats = Array.isArray((dialogsResp as any).chats) ? (dialogsResp as any).chats : [];

      for (const dialog of dialogs.slice(0, 3)) {
        const peerKey = buildPeerKey(dialog.peer);
        const inputPeer = buildInputPeer(Api, dialog.peer, users, chats);
        if (!inputPeer) continue;

        await capture(`messages.getHistory__${peerKey}`, new Api.messages.GetHistory({
          peer: inputPeer,
          offsetId: 0,
          offsetDate: 0,
          addOffset: 0,
          limit: 30,
          maxId: 0,
          minId: 0,
          hash: BigInt(0),
        }));

        await capture(`messages.getPeerDialogs__${peerKey}`, new Api.messages.GetPeerDialogs({
          peers: [inputPeer],
        }));

        // Search within this peer
        await capture(`messages.search__${peerKey}`, new Api.messages.Search({
          peer: inputPeer,
          q: '',
          filter: new Api.InputMessagesFilterEmpty(),
          minDate: 0,
          maxDate: 0,
          offsetId: 0,
          addOffset: 0,
          limit: 10,
          maxId: 0,
          minId: 0,
          hash: BigInt(0),
        }));
      }
    }

    // resolveUsername — use a known public username
    await capture('contacts.resolveUsername__telegram', new Api.contacts.ResolveUsername({
      username: 'telegram',
    }));

    // ─────────────────────────────────────────────────────────────
    // GROUP 2: Message mutations (send → edit → delete)
    // ─────────────────────────────────────────────────────────────
    if (!options.skipMutations && options.targetUser) {
      console.log('\n── Group 2: Message mutations ──');

      // Resolve target user
      const resolved = await capture('contacts.resolveUsername__target', new Api.contacts.ResolveUsername({
        username: options.targetUser,
      }));
      if (!resolved) throw new Error(`Cannot resolve --target-user ${options.targetUser}`);

      const targetUsers = Array.isArray((resolved as any).users) ? (resolved as any).users : [];
      if (targetUsers.length === 0) throw new Error(`User ${options.targetUser} not found`);
      const targetUser = targetUsers[0] as TlLike;
      const targetPeer = new Api.InputPeerUser({
        userId: targetUser.id as bigint,
        accessHash: targetUser.accessHash as bigint,
      });
      const peerKey = `user:${String(targetUser.id)}`;

      // 2a. Send a text message
      const testText = `[test-fixture] ${new Date().toISOString()}`;
      const sendResp = await capture('messages.sendMessage__user', new Api.messages.SendMessage({
        peer: targetPeer,
        message: testText,
        randomId: BigInt(Math.floor(Math.random() * 2 ** 53)),
      }));

      await sleep(1000);

      // Extract sent message ID from Updates
      let sentMsgId: number | undefined;
      if (sendResp) {
        const updates = Array.isArray((sendResp as any).updates) ? (sendResp as any).updates : [];
        for (const upd of updates) {
          if ((upd as TlLike).className === 'UpdateNewMessage') {
            sentMsgId = ((upd as TlLike).message as TlLike)?.id as number;
            break;
          }
        }
      }

      // 2b. Edit the message
      if (sentMsgId) {
        const editText = `[test-fixture-edited] ${new Date().toISOString()}`;
        await capture('messages.editMessage__user', new Api.messages.EditMessage({
          peer: targetPeer,
          id: sentMsgId,
          message: editText,
        }));

        await sleep(1000);

        // 2c. Read history
        await capture('messages.readHistory__user', new Api.messages.ReadHistory({
          peer: targetPeer,
          maxId: sentMsgId,
        }));

        // 2d. Get the message back (verify edit)
        await capture('messages.getMessages__after_edit', new Api.messages.GetMessages({
          id: [new Api.InputMessageID({ id: sentMsgId })],
        }));

        // 2e. Delete the message
        await capture('messages.deleteMessages__user', new Api.messages.DeleteMessages({
          id: [sentMsgId],
          revoke: true,
        }));

        await sleep(500);
      } else {
        console.warn('  [WARN] Could not extract sent message ID, skipping edit/delete');
      }

      // 2f. Send a message with reply
      const sendResp2 = await capture('messages.sendMessage__user_noreply', new Api.messages.SendMessage({
        peer: targetPeer,
        message: `[test-fixture-reply-base] ${new Date().toISOString()}`,
        randomId: BigInt(Math.floor(Math.random() * 2 ** 53)),
      }));
      await sleep(500);

      let baseMsgId: number | undefined;
      if (sendResp2) {
        const updates = Array.isArray((sendResp2 as any).updates) ? (sendResp2 as any).updates : [];
        for (const upd of updates) {
          if ((upd as TlLike).className === 'UpdateNewMessage') {
            baseMsgId = ((upd as TlLike).message as TlLike)?.id as number;
            break;
          }
        }
      }

      if (baseMsgId) {
        await capture('messages.sendMessage__user_reply', new Api.messages.SendMessage({
          peer: targetPeer,
          message: `[test-fixture-reply] ${new Date().toISOString()}`,
          randomId: BigInt(Math.floor(Math.random() * 2 ** 53)),
          replyTo: new Api.InputReplyToMessage({ replyToMsgId: baseMsgId }),
        }));

        await sleep(500);

        // Clean up both messages
        let replyMsgId: number | undefined;
        const lastCapture = fixtures['messages.sendMessage__user_reply'] as any;
        if (lastCapture?.response) {
          const updates = Array.isArray(lastCapture.response.updates) ? lastCapture.response.updates : [];
          for (const upd of updates) {
            if (upd.__className === 'UpdateNewMessage') {
              replyMsgId = upd.message?.id;
              break;
            }
          }
        }
        const cleanupIds = [baseMsgId, ...(replyMsgId ? [replyMsgId] : [])];
        await client.invoke(new Api.messages.DeleteMessages({
          id: cleanupIds,
          revoke: true,
        }));
      }

      // 2g. Forward a message
      // Get latest history for a peer that has messages to forward FROM
      if (dialogsResp) {
        const dialogs = Array.isArray((dialogsResp as any).dialogs) ? (dialogsResp as any).dialogs : [];
        for (const dialog of dialogs.slice(0, 5)) {
          if ((dialog as TlLike).topMessage && (dialog as TlLike).topMessage > 0) {
            const users: TlLike[] = Array.isArray((dialogsResp as any).users) ? (dialogsResp as any).users : [];
            const chats: TlLike[] = Array.isArray((dialogsResp as any).chats) ? (dialogsResp as any).chats : [];
            const fromPeer = buildInputPeer(Api, dialog.peer, users, chats);
            if (!fromPeer) continue;

            const fwdResp = await capture('messages.forwardMessages__user', new Api.messages.ForwardMessages({
              fromPeer,
              id: [(dialog as TlLike).topMessage as number],
              toPeer: targetPeer,
              randomId: [BigInt(Math.floor(Math.random() * 2 ** 53))],
            }));

            await sleep(500);

            // Clean up forwarded message
            if (fwdResp) {
              const fwdUpdates = Array.isArray((fwdResp as any).updates) ? (fwdResp as any).updates : [];
              for (const upd of fwdUpdates) {
                if ((upd as TlLike).className === 'UpdateNewMessage') {
                  const fwdMsgId = ((upd as TlLike).message as TlLike)?.id as number;
                  if (fwdMsgId) {
                    await client.invoke(new Api.messages.DeleteMessages({ id: [fwdMsgId], revoke: true }));
                  }
                  break;
                }
              }
            }
            break;
          }
        }
      }
    } else if (!options.skipMutations) {
      console.warn('\n  [SKIP] Group 2 skipped: --target-user not provided');
    }

    // ─────────────────────────────────────────────────────────────
    // GROUP 3: Media (send photo)
    // ─────────────────────────────────────────────────────────────
    if (!options.skipMutations && options.targetUser) {
      console.log('\n── Group 3: Media ──');

      const resolved = fixtures['contacts.resolveUsername__target'] as any;
      if (resolved?.response) {
        const targetUsers = Array.isArray(resolved.response.users) ? resolved.response.users : [];
        if (targetUsers.length > 0) {
          const targetUser = targetUsers[0];
          const targetPeer = new Api.InputPeerUser({
            userId: BigInt(targetUser.id),
            accessHash: BigInt(targetUser.accessHash),
          });

          // Create a tiny test PNG (1x1 red pixel)
          const pngData = Buffer.from(
            '89504e470d0a1a0a0000000d49484452000000010000000108020000009001' +
            '2e00000000c4944415478016360f8cf00000000020001e221bc330000000' +
            '049454e44ae426082',
            'hex',
          );

          const uploadResult = await client.invoke(new Api.upload.SaveFilePart({
            fileId: BigInt(Date.now()),
            filePart: 0,
            bytes: pngData,
          }));

          if (uploadResult) {
            const fileId = BigInt(Date.now());
            await client.invoke(new Api.upload.SaveFilePart({
              fileId,
              filePart: 0,
              bytes: pngData,
            }));

            const sendMediaResp = await capture('messages.sendMedia__photo', new Api.messages.SendMedia({
              peer: targetPeer,
              media: new Api.InputMediaUploadedPhoto({
                file: new Api.InputFile({
                  id: fileId,
                  parts: 1,
                  name: 'test_fixture.png',
                  md5Checksum: '',
                }),
              }),
              message: '[test-fixture-photo]',
              randomId: BigInt(Math.floor(Math.random() * 2 ** 53)),
            }));

            // Clean up
            if (sendMediaResp) {
              const mediaUpdates = Array.isArray((sendMediaResp as any).updates) ? (sendMediaResp as any).updates : [];
              for (const upd of mediaUpdates) {
                if ((upd as TlLike).className === 'UpdateNewMessage') {
                  const mediaMsgId = ((upd as TlLike).message as TlLike)?.id as number;
                  if (mediaMsgId) {
                    await client.invoke(new Api.messages.DeleteMessages({ id: [mediaMsgId], revoke: true }));
                  }
                  break;
                }
              }
            }
          }
        }
      }
    }

    // ─────────────────────────────────────────────────────────────
    // GROUP 4: Group/Channel operations
    // ─────────────────────────────────────────────────────────────
    console.log('\n── Group 4: Group/Channel ──');

    // 4a. Create a test group, capture everything, delete it
    const groupTitle = `_fixture_group_${Date.now()}`;
    console.log(`  Creating temp group "${groupTitle}"...`);

    const createGroupResp = await capture('messages.createChat', new Api.messages.CreateChat({
      users: [new Api.InputUserSelf()],
      title: groupTitle,
    }));

    if (createGroupResp) {
      const createdChats: TlLike[] = Array.isArray((createGroupResp as any).chats)
        ? (createGroupResp as any).chats : [];
      const chatId = createdChats.length > 0 ? createdChats[0].id as bigint | number : undefined;

      if (chatId !== undefined) {
        const chatPeer = new Api.InputPeerChat({ chatId });

        await capture('messages.getFullChat', new Api.messages.GetFullChat({ chatId }));

        await capture('messages.getHistory__chat', new Api.messages.GetHistory({
          peer: chatPeer,
          offsetId: 0, offsetDate: 0, addOffset: 0, limit: 10,
          maxId: 0, minId: 0, hash: BigInt(0),
        }));

        // Send a message in the group
        if (!options.skipMutations) {
          await capture('messages.sendMessage__chat', new Api.messages.SendMessage({
            peer: chatPeer,
            message: `[test-fixture-group] ${new Date().toISOString()}`,
            randomId: BigInt(Math.floor(Math.random() * 2 ** 53)),
          }));
          await sleep(500);
        }

        // Clean up group
        console.log(`  Deleting temp group chat:${String(chatId)}...`);
        try {
          await client.invoke(new Api.messages.DeleteChat({ chatId }));
        } catch (e) {
          console.warn(`  Could not delete group: ${(e as Error).message}`);
        }
      }
    }

    // 4b. Create a test supergroup (megagroup), capture, delete
    const channelTitle = `_fixture_supergroup_${Date.now()}`;
    console.log(`  Creating temp supergroup "${channelTitle}"...`);

    const createChannelResp = await capture('channels.createChannel', new Api.channels.CreateChannel({
      title: channelTitle,
      about: 'Test fixture supergroup',
      megagroup: true,
    }));

    if (createChannelResp) {
      const createdChats: TlLike[] = Array.isArray((createChannelResp as any).chats)
        ? (createChannelResp as any).chats : [];
      const channelId = createdChats.length > 0 ? createdChats[0].id as bigint | number : undefined;
      const accessHash = createdChats.length > 0 ? createdChats[0].accessHash as bigint : undefined;

      if (channelId !== undefined && accessHash !== undefined) {
        const channelInput = new Api.InputChannel({ channelId, accessHash });
        const channelPeer = new Api.InputPeerChannel({ channelId, accessHash });

        await capture('channels.getFullChannel', new Api.channels.GetFullChannel({
          channel: channelInput,
        }));

        await capture('channels.getParticipants', new Api.channels.GetParticipants({
          channel: channelInput,
          filter: new Api.ChannelParticipantsRecent(),
          offset: 0,
          limit: 100,
          hash: BigInt(0),
        }));

        await capture('messages.getHistory__channel', new Api.messages.GetHistory({
          peer: channelPeer,
          offsetId: 0, offsetDate: 0, addOffset: 0, limit: 10,
          maxId: 0, minId: 0, hash: BigInt(0),
        }));

        if (!options.skipMutations) {
          await capture('messages.sendMessage__channel', new Api.messages.SendMessage({
            peer: channelPeer,
            message: `[test-fixture-channel] ${new Date().toISOString()}`,
            randomId: BigInt(Math.floor(Math.random() * 2 ** 53)),
          }));
          await sleep(500);
        }

        // Clean up
        console.log(`  Deleting temp supergroup channel:${String(channelId)}...`);
        try {
          await client.invoke(new Api.channels.DeleteChannel({ channel: channelInput }));
        } catch (e) {
          console.warn(`  Could not delete channel: ${(e as Error).message}`);
        }
      }
    }

    // ─────────────────────────────────────────────────────────────
    // GROUP 5: updates.getDifference
    // ─────────────────────────────────────────────────────────────
    console.log('\n── Group 5: Updates ──');

    const stateFixture = fixtures['updates.getState'] as any;
    if (stateFixture?.response) {
      const pts = stateFixture.response.pts;
      const date = stateFixture.response.date;
      const qts = stateFixture.response.qts;
      if (pts && date) {
        await capture('updates.getDifference', new Api.updates.GetDifference({
          pts: Math.max(0, pts - 5),
          date: date - 60,
          qts: qts || 0,
        }));
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Save combined fixture index
    // ─────────────────────────────────────────────────────────────
    const manifest = {
      capturedAt: new Date().toISOString(),
      fixtureCount,
      methods: Object.keys(fixtures),
      errors: Object.entries(fixtures)
        .filter(([, v]) => (v as any)?.error)
        .map(([k, v]) => ({ method: k, error: (v as any).error })),
    };

    writeFileSync(
      resolve(options.outputDir, '_manifest.json'),
      JSON.stringify(manifest, null, 2),
    );

    console.log(`\n=== Done! ${fixtureCount} fixtures saved to ${options.outputDir} ===`);
    if (manifest.errors.length > 0) {
      console.log(`  ${manifest.errors.length} error(s):`);
      for (const e of manifest.errors) console.log(`    - ${e.method}: ${e.error}`);
    }

  } finally {
    client.destroy();
  }
}

// ─── Peer helpers (same as capture_official_telegram.ts) ─────────────

function buildInputPeer(Api: any, peer: TlLike, users: TlLike[], chats: TlLike[]) {
  if (!peer?.className) return undefined;
  if (peer.className === 'PeerUser') {
    const user = users.find((e) => e.className === 'User' && e.id === peer.userId);
    if (!user || typeof user.accessHash !== 'bigint') return undefined;
    return new Api.InputPeerUser({ userId: user.id, accessHash: user.accessHash });
  }
  if (peer.className === 'PeerChat') {
    return new Api.InputPeerChat({ chatId: peer.chatId });
  }
  if (peer.className === 'PeerChannel') {
    const chat = chats.find((e) =>
      (e.className === 'Channel' || e.className === 'ChannelForbidden') && e.id === peer.channelId,
    );
    if (!chat || typeof chat.accessHash !== 'bigint') return undefined;
    return new Api.InputPeerChannel({ channelId: chat.id, accessHash: chat.accessHash });
  }
  return undefined;
}

function buildPeerKey(peer: TlLike) {
  if (peer.className === 'PeerUser') return `user:${String(peer.userId)}`;
  if (peer.className === 'PeerChat') return `chat:${String(peer.chatId)}`;
  if (peer.className === 'PeerChannel') return `channel:${String(peer.channelId)}`;
  return 'unknown';
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
