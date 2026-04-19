/**
 * Capture test fixtures from official Telegram servers.
 *
 * Uses the `telegram` (GramJS) npm package with StringSession — same as capture_tool.
 * Saves each API response as an individual JSON fixture file.
 *
 * Usage:
 *   TG_API_ID=... TG_API_HASH=... TG_SESSION=... node scripts/capture_test_fixtures.mjs
 *
 * Optional env vars:
 *   TARGET_USER=<username>    — for send/edit/delete tests (without @)
 *   SKIP_MUTATIONS=1          — skip all writes (read-only capture)
 */

import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, join } from "path";

const API_ID = parseInt(process.env.TG_API_ID || "0");
const API_HASH = process.env.TG_API_HASH || "";
const SESSION_STRING = process.env.TG_SESSION || "";
const TARGET_USER = process.env.TARGET_USER || "";
const SKIP_MUTATIONS = process.env.SKIP_MUTATIONS === "1";

if (!API_ID || !API_HASH) {
  console.error("Set TG_API_ID and TG_API_HASH");
  process.exit(1);
}

const OUTPUT_DIR = resolve(process.cwd(), "..", "self_hosted_version", "captures", "test-fixtures");

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

// ─── TL serializer ──────────────────────────────────────────────────
function ser(obj, depth = 0) {
  if (depth > 12) return "[max depth]";
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "bigint") return obj.toString();
  if (typeof obj !== "object") return obj;
  if (Buffer.isBuffer(obj)) return { __type: "Buffer", hex: obj.toString("hex").slice(0, 2048) };
  if (obj instanceof Uint8Array) return { __type: "Buffer", hex: Buffer.from(obj).toString("hex").slice(0, 2048) };

  if (Array.isArray(obj)) return obj.map((x) => ser(x, depth + 1));

  const r = {};
  if (obj.className) r.__className = obj.className;
  if (obj.CONSTRUCTOR_ID !== undefined) r.__constructorId = obj.CONSTRUCTOR_ID >>> 0;

  for (const key of Object.keys(obj)) {
    if (key.startsWith("_") || key === "CONSTRUCTOR_ID" || key === "SUBCLASS_OF_ID" || key === "classType") continue;
    try { r[key] = ser(obj[key], depth + 1); } catch { r[key] = "[error]"; }
  }
  return r;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  ensureDir(OUTPUT_DIR);
  console.log(`Output: ${OUTPUT_DIR}\n`);

  const session = new StringSession(SESSION_STRING);
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => { throw new Error("Session expired — re-login needed"); },
    password: async () => { throw new Error("Session expired — re-login needed"); },
    phoneCode: async () => { throw new Error("Session expired — re-login needed"); },
    onError: (err) => console.error("Auth error:", err),
  });

  console.log("✅ Connected to official Telegram\n");

  let fixtureCount = 0;
  const errors = [];

  async function capture(name, request, extra) {
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_");
    console.log(`  [${++fixtureCount}] ${name}...`);
    try {
      const response = await client.invoke(request);
      const data = {
        method: name,
        capturedAt: new Date().toISOString(),
        request: ser(request),
        response: ser(response),
        ...(extra || {}),
      };
      writeFileSync(join(OUTPUT_DIR, `${safeName}.json`), JSON.stringify(data, null, 2));
      return response;
    } catch (e) {
      console.error(`    ❌ ${e.message}`);
      errors.push({ method: name, error: e.message });
      writeFileSync(join(OUTPUT_DIR, `${safeName}.json`), JSON.stringify({
        method: name, capturedAt: new Date().toISOString(), error: e.message,
      }, null, 2));
      return undefined;
    }
  }

  function extractSentMsgId(resp) {
    if (!resp) return undefined;
    // UpdateShortSentMessage (P2P) — has .id directly
    if (resp.className === "UpdateShortSentMessage" && resp.id) return resp.id;
    // Updates container — look for UpdateNewMessage or UpdateNewChannelMessage
    const updates = resp.updates || [];
    for (const upd of updates) {
      if ((upd.className === "UpdateNewMessage" || upd.className === "UpdateNewChannelMessage") && upd.message?.id) return upd.message.id;
    }
    return undefined;
  }

  // ── GROUP 1: Read-only fixtures ───────────────────────────────────

  console.log("── Group 1: Read-only ──");

  await capture("help.getConfig", new Api.help.GetConfig());
  await capture("updates.getState", new Api.updates.GetState());

  await capture("users.getFullUser__self", new Api.users.GetFullUser({
    id: new Api.InputUserSelf(),
  }));

  await capture("users.getUsers__self", new Api.users.GetUsers({
    id: [new Api.InputUserSelf()],
  }));

  // Dialogs
  const dialogsResp = await capture("messages.getDialogs", new Api.messages.GetDialogs({
    offsetDate: 0,
    offsetId: 0,
    offsetPeer: new Api.InputPeerEmpty(),
    limit: 20,
    hash: BigInt(0),
  }));

  await capture("messages.getPinnedDialogs", new Api.messages.GetPinnedDialogs({
    folderId: 0,
  }));

  await capture("messages.getDialogFilters", new Api.messages.GetDialogFilters());

  // Contacts
  await capture("contacts.getContacts", new Api.contacts.GetContacts({
    hash: BigInt(0),
  }));

  await capture("contacts.search__test", new Api.contacts.Search({
    q: "telegram",
    limit: 10,
  }));

  await capture("contacts.resolveUsername__telegram", new Api.contacts.ResolveUsername({
    username: "telegram",
  }));

  // History for first 3 dialog peers
  if (dialogsResp) {
    const dialogs = dialogsResp.dialogs || [];
    const users = dialogsResp.users || [];
    const chats = dialogsResp.chats || [];

    for (const dialog of dialogs.slice(0, 3)) {
      const peer = dialog.peer;
      const peerKey = buildPeerKey(peer);
      const inputPeer = buildInputPeer(peer, users, chats);
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
        peers: [new Api.InputDialogPeer({ peer: inputPeer })],
      }));

      // Search in this peer (empty query = recent messages)
      await capture(`messages.search__${peerKey}`, new Api.messages.Search({
        peer: inputPeer,
        q: "",
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

  // ── GROUP 2: Message mutations ────────────────────────────────────

  if (!SKIP_MUTATIONS && TARGET_USER) {
    console.log("\n── Group 2: Message mutations ──");

    const resolved = await capture("contacts.resolveUsername__target", new Api.contacts.ResolveUsername({
      username: TARGET_USER,
    }));

    if (resolved && resolved.users?.length > 0) {
      const tUser = resolved.users[0];
      const targetPeer = new Api.InputPeerUser({
        userId: tUser.id,
        accessHash: tUser.accessHash,
      });
      const peerKey = `user_${tUser.id}`;

      // Get history before mutations
      await capture(`messages.getHistory__before__${peerKey}`, new Api.messages.GetHistory({
        peer: targetPeer,
        offsetId: 0, offsetDate: 0, addOffset: 0, limit: 10, maxId: 0, minId: 0, hash: BigInt(0),
      }));

      // 2a. Send a text message
      const sendResp = await capture("messages.sendMessage__user", new Api.messages.SendMessage({
        peer: targetPeer,
        message: `[fixture] ${new Date().toISOString()}`,
        randomId: BigInt(Math.floor(Math.random() * 2 ** 53)),
      }));
      const sentMsgId = extractSentMsgId(sendResp);
      await sleep(1000);

      if (sentMsgId) {
        // 2b. Edit the message
        await capture("messages.editMessage__user", new Api.messages.EditMessage({
          peer: targetPeer,
          id: sentMsgId,
          message: `[fixture-edited] ${new Date().toISOString()}`,
        }));
        await sleep(500);

        // 2c. Get the message back (verify edit visible)
        await capture("messages.getMessages__after_edit", new Api.messages.GetMessages({
          id: [new Api.InputMessageID({ id: sentMsgId })],
        }));

        // 2d. Read history
        await capture("messages.readHistory__user", new Api.messages.ReadHistory({
          peer: targetPeer,
          maxId: sentMsgId,
        }));

        // 2e. Delete the message
        await capture("messages.deleteMessages__user", new Api.messages.DeleteMessages({
          id: [sentMsgId],
          revoke: true,
        }));
        await sleep(500);
      }

      // 2f. Send + reply chain
      const baseResp = await capture("messages.sendMessage__base", new Api.messages.SendMessage({
        peer: targetPeer,
        message: `[fixture-base] ${new Date().toISOString()}`,
        randomId: BigInt(Math.floor(Math.random() * 2 ** 53)),
      }));
      const baseMsgId = extractSentMsgId(baseResp);
      await sleep(500);

      if (baseMsgId) {
        const replyResp = await capture("messages.sendMessage__reply", new Api.messages.SendMessage({
          peer: targetPeer,
          message: `[fixture-reply] ${new Date().toISOString()}`,
          randomId: BigInt(Math.floor(Math.random() * 2 ** 53)),
          replyTo: new Api.InputReplyToMessage({ replyToMsgId: baseMsgId }),
        }));
        const replyMsgId = extractSentMsgId(replyResp);
        await sleep(500);

        // Clean up
        const cleanupIds = [baseMsgId, ...(replyMsgId ? [replyMsgId] : [])];
        await client.invoke(new Api.messages.DeleteMessages({ id: cleanupIds, revoke: true }));
      }

      // 2g. Forward — send a msg to self first, then forward IT to target user
      const fwdBaseResp = await capture("messages.sendMessage__fwd_source", new Api.messages.SendMessage({
        peer: new Api.InputPeerSelf(),
        message: `[fixture-fwd-source] ${new Date().toISOString()}`,
        randomId: BigInt(Math.floor(Math.random() * 2 ** 53)),
      }));
      const fwdSourceId = extractSentMsgId(fwdBaseResp);
      if (fwdSourceId) {
        await sleep(500);
        const fwdResp = await capture("messages.forwardMessages__user", new Api.messages.ForwardMessages({
          fromPeer: new Api.InputPeerSelf(),
          id: [fwdSourceId],
          toPeer: targetPeer,
          randomId: [BigInt(Math.floor(Math.random() * 2 ** 53))],
        }));
        const fwdMsgId = extractSentMsgId(fwdResp);
        // Clean up both
        const cleanup = [fwdSourceId];
        if (fwdMsgId) cleanup.push(fwdMsgId);
        await client.invoke(new Api.messages.DeleteMessages({ id: cleanup, revoke: true }));
      }

      // History after mutations
      await capture(`messages.getHistory__after__${peerKey}`, new Api.messages.GetHistory({
        peer: targetPeer,
        offsetId: 0, offsetDate: 0, addOffset: 0, limit: 10, maxId: 0, minId: 0, hash: BigInt(0),
      }));

    } else {
      console.warn("  ⚠️  Could not resolve TARGET_USER");
    }
  } else if (!SKIP_MUTATIONS) {
    console.log("\n  [SKIP] Group 2: set TARGET_USER=<username> for mutation tests");
  }

  // ── GROUP 3: Media ────────────────────────────────────────────────

  if (!SKIP_MUTATIONS && TARGET_USER) {
    console.log("\n── Group 3: Media ──");

    // Resolve target directly
    let targetPeer = null;
    try {
      const resolved = await client.invoke(new Api.contacts.ResolveUsername({ username: TARGET_USER }));
      if (resolved?.users?.length > 0) {
        const u = resolved.users[0];
        targetPeer = new Api.InputPeerUser({
          userId: u.id,
          accessHash: u.accessHash,
        });
      }
    } catch {}

    if (targetPeer) {
      // Create a tiny 1x1 red PNG
      const pngData = Buffer.from(
        "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415478016360f80f000000020001e221bc330000000049454e44ae426082",
        "hex",
      );

      const fileId = BigInt(Date.now());
      await client.invoke(new Api.upload.SaveFilePart({
        fileId,
        filePart: 0,
        bytes: pngData,
      }));

      const mediaResp = await capture("messages.sendMedia__photo", new Api.messages.SendMedia({
        peer: targetPeer,
        media: new Api.InputMediaUploadedPhoto({
          file: new Api.InputFile({
            id: fileId,
            parts: 1,
            name: "test_fixture.png",
            md5Checksum: "",
          }),
        }),
        message: "[fixture-photo]",
        randomId: BigInt(Math.floor(Math.random() * 2 ** 53)),
      }));

      const mediaMsgId = extractSentMsgId(mediaResp);
      if (mediaMsgId) {
        await sleep(500);
        await client.invoke(new Api.messages.DeleteMessages({ id: [mediaMsgId], revoke: true }));
      }
    }
  }

  // ── GROUP 4: Group/Channel ────────────────────────────────────────

  console.log("\n── Group 4: Group/Channel ──");

  // 4a. Create a temp group
  const groupTitle = `_fix_grp_${Date.now()}`;
  console.log(`  Creating temp group "${groupTitle}"...`);
  const createGroupResp = await capture("messages.createChat", new Api.messages.CreateChat({
    users: [new Api.InputUserSelf()],
    title: groupTitle,
  }));

  if (createGroupResp) {
    let chatId = createGroupResp.chats?.[0]?.id || createGroupResp.updates?.chats?.[0]?.id;
    if (chatId) {
      const chatPeer = new Api.InputPeerChat({ chatId });

      await capture("messages.getFullChat", new Api.messages.GetFullChat({ chatId }));

      await capture("messages.getHistory__chat", new Api.messages.GetHistory({
        peer: chatPeer,
        offsetId: 0, offsetDate: 0, addOffset: 0, limit: 10, maxId: 0, minId: 0, hash: BigInt(0),
      }));

      if (!SKIP_MUTATIONS) {
        await capture("messages.sendMessage__chat", new Api.messages.SendMessage({
          peer: chatPeer,
          message: `[fixture-group] ${new Date().toISOString()}`,
          randomId: BigInt(Math.floor(Math.random() * 2 ** 53)),
        }));
        await sleep(500);
      }

      console.log(`  Deleting group...`);
      try { await client.invoke(new Api.messages.DeleteChat({ chatId })); }
      catch (e) { console.warn(`  ⚠️  ${e.message}`); }
    }
  }

  // 4b. Create a temp supergroup
  const sgTitle = `_fix_sg_${Date.now()}`;
  console.log(`  Creating temp supergroup "${sgTitle}"...`);
  const createSgResp = await capture("channels.createChannel", new Api.channels.CreateChannel({
    title: sgTitle,
    about: "fixture supergroup",
    megagroup: true,
  }));

  if (createSgResp) {
    const ch = createSgResp.chats?.[0];
    if (ch?.id && ch?.accessHash) {
      const channelInput = new Api.InputChannel({ channelId: ch.id, accessHash: ch.accessHash });
      const channelPeer = new Api.InputPeerChannel({ channelId: ch.id, accessHash: ch.accessHash });

      await capture("channels.getFullChannel", new Api.channels.GetFullChannel({
        channel: channelInput,
      }));

      await capture("channels.getParticipants", new Api.channels.GetParticipants({
        channel: channelInput,
        filter: new Api.ChannelParticipantsRecent(),
        offset: 0,
        limit: 100,
        hash: BigInt(0),
      }));

      await capture("messages.getHistory__channel", new Api.messages.GetHistory({
        peer: channelPeer,
        offsetId: 0, offsetDate: 0, addOffset: 0, limit: 10, maxId: 0, minId: 0, hash: BigInt(0),
      }));

      if (!SKIP_MUTATIONS) {
        await capture("messages.sendMessage__channel", new Api.messages.SendMessage({
          peer: channelPeer,
          message: `[fixture-channel] ${new Date().toISOString()}`,
          randomId: BigInt(Math.floor(Math.random() * 2 ** 53)),
        }));
        await sleep(500);
      }

      console.log(`  Deleting supergroup...`);
      try { await client.invoke(new Api.channels.DeleteChannel({ channel: channelInput })); }
      catch (e) { console.warn(`  ⚠️  ${e.message}`); }
    }
  }

  // ── GROUP 5: updates.getDifference ────────────────────────────────

  console.log("\n── Group 5: Updates ──");
  const state = await client.invoke(new Api.updates.GetState());
  if (state?.pts && state?.date) {
    await capture("updates.getDifference", new Api.updates.GetDifference({
      pts: Math.max(0, state.pts - 5),
      date: state.date - 60,
      qts: state.qts || 0,
    }));
  }

  // ── GROUP 6: Account & Settings ───────────────────────────────────

  console.log("\n── Group 6: Account & Settings ──");

  await capture("account.getNotifySettings__pm", new Api.account.GetNotifySettings({
    peer: new Api.InputNotifyPeer({ peer: new Api.InputPeerSelf() }),
  }));

  // Default notification settings per peer type (used by web client for defaults)
  await capture("account.getNotifySettings__users", new Api.account.GetNotifySettings({
    peer: new Api.InputNotifyUsers(),
  }));

  await capture("account.getNotifySettings__chats", new Api.account.GetNotifySettings({
    peer: new Api.InputNotifyChats(),
  }));

  await capture("account.getNotifySettings__broadcasts", new Api.account.GetNotifySettings({
    peer: new Api.InputNotifyBroadcasts(),
  }));

  await capture("account.getAuthorizations", new Api.account.GetAuthorizations());

  await capture("account.getGlobalPrivacySettings", new Api.account.GetGlobalPrivacySettings());

  await capture("account.getContentSettings", new Api.account.GetContentSettings());

  await capture("account.getPassword", new Api.account.GetPassword());

  await capture("account.getWallPapers", new Api.account.GetWallPapers({
    hash: BigInt(0),
  }));

  await capture("account.getContactSignUpNotification", new Api.account.GetContactSignUpNotification());

  await capture("account.getPrivacy__statusTimestamp", new Api.account.GetPrivacy({
    key: new Api.InputPrivacyKeyStatusTimestamp(),
  }));

  // ── GROUP 7: Help methods ─────────────────────────────────────────

  console.log("\n── Group 7: Help methods ──");

  await capture("help.getAppConfig", new Api.help.GetAppConfig({
    hash: 0,
  }));

  await capture("help.getCountriesList", new Api.help.GetCountriesList({
    langCode: "en",
    hash: 0,
  }));

  await capture("help.getTimezonesList", new Api.help.GetTimezonesList({
    hash: 0,
  }));

  await capture("help.getNearestDc", new Api.help.GetNearestDc());

  try {
    await capture("help.getTermsOfServiceUpdate", new Api.help.GetTermsOfServiceUpdate());
  } catch {}

  await capture("help.getPeerColors", new Api.help.GetPeerColors({
    hash: 0,
  }));

  await capture("help.getPeerProfileColors", new Api.help.GetPeerProfileColors({
    hash: 0,
  }));

  // ── GROUP 8: Langpack ─────────────────────────────────────────────

  console.log("\n── Group 8: Langpack ──");

  await capture("langpack.getLanguages", new Api.langpack.GetLanguages({
    langPack: "tdesktop",
  }));

  await capture("langpack.getLangPack", new Api.langpack.GetLangPack({
    langPack: "tdesktop",
    langCode: "en",
  }));

  await capture("langpack.getStrings__sample", new Api.langpack.GetStrings({
    langPack: "tdesktop",
    langCode: "en",
    keys: ["lng_settings_save", "lng_cancel", "lng_ok"],
  }));

  // ── GROUP 9: Messages extras ──────────────────────────────────────

  console.log("\n── Group 9: Messages extras ──");

  await capture("messages.getAvailableReactions", new Api.messages.GetAvailableReactions({
    hash: 0,
  }));

  await capture("messages.getAllStickers", new Api.messages.GetAllStickers({
    hash: BigInt(0),
  }));

  await capture("messages.getEmojiStickers", new Api.messages.GetEmojiStickers({
    hash: BigInt(0),
  }));

  await capture("messages.getFeaturedStickers", new Api.messages.GetFeaturedStickers({
    hash: BigInt(0),
  }));

  await capture("messages.getRecentStickers", new Api.messages.GetRecentStickers({
    hash: BigInt(0),
  }));

  await capture("messages.getSavedGifs", new Api.messages.GetSavedGifs({
    hash: BigInt(0),
  }));

  await capture("messages.getFavedStickers", new Api.messages.GetFavedStickers({
    hash: BigInt(0),
  }));

  await capture("messages.getDefaultHistoryTTL", new Api.messages.GetDefaultHistoryTTL());

  await capture("messages.getTopReactions", new Api.messages.GetTopReactions({
    limit: 50,
    hash: BigInt(0),
  }));

  await capture("messages.getRecentReactions", new Api.messages.GetRecentReactions({
    limit: 50,
    hash: BigInt(0),
  }));

  await capture("messages.getDialogUnreadMarks", new Api.messages.GetDialogUnreadMarks());

  await capture("messages.getAttachMenuBots", new Api.messages.GetAttachMenuBots({
    hash: BigInt(0),
  }));

  await capture("messages.getEmojiKeywords", new Api.messages.GetEmojiKeywords({
    langCode: "en",
  }));

  await capture("messages.getSavedReactionTags", new Api.messages.GetSavedReactionTags({
    hash: BigInt(0),
  }));

  await capture("messages.getQuickReplies", new Api.messages.GetQuickReplies({
    hash: BigInt(0),
  }));

  await capture("messages.getDefaultTagReactions", new Api.messages.GetDefaultTagReactions({
    hash: BigInt(0),
  }));

  // Draft — save then read all
  if (!SKIP_MUTATIONS) {
    await capture("messages.saveDraft__self", new Api.messages.SaveDraft({
      peer: new Api.InputPeerSelf(),
      message: "[fixture-draft]",
    }));
    await sleep(200);
    await capture("messages.getAllDrafts", new Api.messages.GetAllDrafts());
    // Clean up draft
    try {
      await client.invoke(new Api.messages.SaveDraft({
        peer: new Api.InputPeerSelf(),
        message: "",
      }));
    } catch {}
  }

  await capture("messages.getWebPagePreview", new Api.messages.GetWebPagePreview({
    message: "https://telegram.org",
  }));

  // searchGlobal
  await capture("messages.searchGlobal", new Api.messages.SearchGlobal({
    q: "test",
    filter: new Api.InputMessagesFilterEmpty(),
    minDate: 0,
    maxDate: 0,
    offsetRate: 0,
    offsetPeer: new Api.InputPeerEmpty(),
    offsetId: 0,
    limit: 10,
  }));

  // ── GROUP 10: Contacts extras ─────────────────────────────────────

  console.log("\n── Group 10: Contacts extras ──");

  await capture("contacts.getTopPeers", new Api.contacts.GetTopPeers({
    correspondents: true,
    offset: 0,
    limit: 10,
    hash: BigInt(0),
  }));

  await capture("contacts.getStatuses", new Api.contacts.GetStatuses());

  await capture("contacts.getBlocked", new Api.contacts.GetBlocked({
    offset: 0,
    limit: 10,
  }));

  // ── GROUP 11: Sticker sets ────────────────────────────────────────

  console.log("\n── Group 11: Sticker sets ──");

  // Get one sticker set by short name — "AnimatedEmojies" is a well-known one
  await capture("messages.getStickerSet__animated", new Api.messages.GetStickerSet({
    stickerset: new Api.InputStickerSetAnimatedEmoji(),
    hash: 0,
  }));

  // messages.getCustomEmojiDocuments — needs known IDs, try empty
  // Skip if we don't have IDs

  // ── GROUP 12: Payments (read-only) ────────────────────────────────

  console.log("\n── Group 12: Payments ──");

  await capture("payments.getStarsTopupOptions", new Api.payments.GetStarsTopupOptions());

  await capture("payments.getStarsStatus", new Api.payments.GetStarsStatus({
    peer: new Api.InputPeerSelf(),
  }));

  // ── GROUP 13: Stories (read-only) ─────────────────────────────────

  console.log("\n── Group 13: Stories ──");

  await capture("stories.getAllStories", new Api.stories.GetAllStories());

  await capture("stories.getPeerMaxIDs", new Api.stories.GetPeerMaxIDs({
    id: [new Api.InputPeerSelf()],
  }));

  // ── GROUP 14: Saved dialogs ───────────────────────────────────────

  console.log("\n── Group 14: Saved ──");

  await capture("messages.getSavedDialogs", new Api.messages.GetSavedDialogs({
    offsetDate: 0,
    offsetId: 0,
    offsetPeer: new Api.InputPeerEmpty(),
    limit: 20,
    hash: BigInt(0),
  }));

  await capture("messages.getPinnedSavedDialogs", new Api.messages.GetPinnedSavedDialogs());

  // ── GROUP 15: Additional Messages read-only ───────────────────

  console.log("\n── Group 15: Additional Messages read-only ──");

  await capture("messages.getAvailableEffects", new Api.messages.GetAvailableEffects({
    hash: 0,
  }));

  await capture("messages.getFeaturedEmojiStickers", new Api.messages.GetFeaturedEmojiStickers({
    hash: BigInt(0),
  }));

  await capture("messages.getEmojiKeywordsDifference", new Api.messages.GetEmojiKeywordsDifference({
    langCode: "en",
    fromVersion: 0,
  }));

  await capture("messages.getEmojiURL", new Api.messages.GetEmojiURL({
    langCode: "en",
  }));

  await capture("messages.getStickers", new Api.messages.GetStickers({
    emoticon: "😀",
    hash: BigInt(0),
  }));

  await capture("messages.getPaidReactionPrivacy", new Api.messages.GetPaidReactionPrivacy());

  await capture("messages.getScheduledHistory", new Api.messages.GetScheduledHistory({
    peer: new Api.InputPeerSelf(),
    hash: BigInt(0),
  }));

  await capture("messages.getSavedHistory", new Api.messages.GetSavedHistory({
    peer: new Api.InputPeerSelf(),
    offsetId: 0,
    offsetDate: 0,
    addOffset: 0,
    limit: 20,
    maxId: 0,
    minId: 0,
    hash: BigInt(0),
  }));

  // getSponsoredMessages — needs a channel peer from dialogs
  if (dialogsResp) {
    const chats = dialogsResp.chats || [];
    const firstChannel = chats.find((c) => c.className === "Channel" && c.accessHash);
    if (firstChannel) {
      const channelPeer = new Api.InputPeerChannel({
        channelId: firstChannel.id,
        accessHash: firstChannel.accessHash,
      });
      await capture("messages.getSponsoredMessages", new Api.messages.GetSponsoredMessages({
        peer: channelPeer,
      }));
    } else {
      console.log("  [SKIP] messages.getSponsoredMessages: no channel found in dialogs");
    }
  }

  // ── GROUP 16: Additional Help ─────────────────────────────────

  console.log("\n── Group 16: Additional Help ──");

  await capture("help.getPromoData", new Api.help.GetPromoData());

  // help.getTermsOfServiceUpdate — already captured in Group 7 but retry if missing
  if (!existsSync(join(OUTPUT_DIR, "help.getTermsOfServiceUpdate.json"))) {
    try {
      await capture("help.getTermsOfServiceUpdate", new Api.help.GetTermsOfServiceUpdate());
    } catch {}
  }

  // ── GROUP 17: Langpack extras ─────────────────────────────────

  console.log("\n── Group 17: Langpack extras ──");

  await capture("langpack.getDifference", new Api.langpack.GetDifference({
    langPack: "tdesktop",
    langCode: "en",
    fromVersion: 0,
  }));

  await capture("langpack.getLanguage", new Api.langpack.GetLanguage({
    langPack: "tdesktop",
    langCode: "en",
  }));

  // ── GROUP 18: Additional Account ──────────────────────────────

  console.log("\n── Group 18: Additional Account ──");

  await capture("account.getCollectibleEmojiStatuses", new Api.account.GetCollectibleEmojiStatuses({
    hash: BigInt(0),
  }));

  await capture("account.getNotifyExceptions", new Api.account.GetNotifyExceptions({
    compareSound: false,
  }));

  // updateNotifySettings — set to defaults then restore
  if (!SKIP_MUTATIONS) {
    await capture("account.updateNotifySettings", new Api.account.UpdateNotifySettings({
      peer: new Api.InputNotifyPeer({ peer: new Api.InputPeerSelf() }),
      settings: new Api.InputPeerNotifySettings({
        muteUntil: 0,
        showPreviews: true,
      }),
    }));
  }

  // updateProfile — read current, change back to same values
  if (!SKIP_MUTATIONS) {
    const me = await client.invoke(new Api.users.GetUsers({ id: [new Api.InputUserSelf()] }));
    if (me?.length > 0) {
      const firstName = me[0].firstName || "Test";
      const lastName = me[0].lastName || "";
      await capture("account.updateProfile", new Api.account.UpdateProfile({
        firstName,
        lastName,
      }));
    }
  }

  // ── GROUP 19: Additional Payments ─────────────────────────────

  console.log("\n── Group 19: Additional Payments ──");

  await capture("payments.getStarGifts", new Api.payments.GetStarGifts({
    hash: 0,
  }));

  await capture("payments.getSavedStarGifts", new Api.payments.GetSavedStarGifts({
    peer: new Api.InputPeerSelf(),
    offset: "",
    limit: 20,
  }));

  // ── GROUP 20: Channel operations ──────────────────────────────

  console.log("\n── Group 20: Channel ops ──");

  const sg2Title = `_fix_sg2_${Date.now()}`;
  console.log(`  Creating temp supergroup "${sg2Title}"...`);
  const sg2Resp = await client.invoke(new Api.channels.CreateChannel({
    title: sg2Title,
    about: "fixture capture v2",
    megagroup: true,
  }));

  if (sg2Resp) {
    const sg2Chat = sg2Resp.chats?.[0];
    if (sg2Chat?.id && sg2Chat?.accessHash) {
      const sg2Input = new Api.InputChannel({ channelId: sg2Chat.id, accessHash: sg2Chat.accessHash });
      const sg2Peer = new Api.InputPeerChannel({ channelId: sg2Chat.id, accessHash: sg2Chat.accessHash });

      // Send a test message into the supergroup
      const sg2MsgResp = await client.invoke(new Api.messages.SendMessage({
        peer: sg2Peer,
        message: `[fixture-sg2] ${new Date().toISOString()}`,
        randomId: BigInt(Math.floor(Math.random() * 2 ** 53)),
      }));
      const sg2MsgId = extractSentMsgId(sg2MsgResp);
      await sleep(500);

      // channels.getMessages
      if (sg2MsgId) {
        await capture("channels.getMessages", new Api.channels.GetMessages({
          channel: sg2Input,
          id: [new Api.InputMessageID({ id: sg2MsgId })],
        }));
      }

      // channels.getParticipant (self)
      await capture("channels.getParticipant__self", new Api.channels.GetParticipant({
        channel: sg2Input,
        participant: new Api.InputPeerSelf(),
      }));

      // channels.readHistory
      await capture("channels.readHistory__channel", new Api.channels.ReadHistory({
        channel: sg2Input,
        maxId: sg2MsgId || 1,
      }));

      // sendReaction on the message (if we have an ID)
      if (sg2MsgId && !SKIP_MUTATIONS) {
        await capture("messages.sendReaction", new Api.messages.SendReaction({
          peer: sg2Peer,
          msgId: sg2MsgId,
          reaction: [new Api.ReactionEmoji({ emoticon: "👍" })],
        }));
        await sleep(300);
      }

      // channels.editPhoto — upload a small photo first
      if (!SKIP_MUTATIONS) {
        const pngPhotoData = Buffer.from(
          "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415478016360f80f000000020001e221bc330000000049454e44ae426082",
          "hex",
        );
        const photoFileId = BigInt(Date.now() + 1);
        await client.invoke(new Api.upload.SaveFilePart({
          fileId: photoFileId,
          filePart: 0,
          bytes: pngPhotoData,
        }));
        await capture("channels.editPhoto", new Api.channels.EditPhoto({
          channel: sg2Input,
          photo: new Api.InputChatUploadedPhoto({
            file: new Api.InputFile({
              id: photoFileId,
              parts: 1,
              name: "channel_photo.png",
              md5Checksum: "",
            }),
          }),
        }));
      }

      // messages.getExportedChatInvites
      await capture("messages.getExportedChatInvites", new Api.messages.GetExportedChatInvites({
        peer: sg2Peer,
        adminId: new Api.InputUserSelf(),
        limit: 10,
      }));

      // messages.getChatInviteImporters — try to get for the default link
      try {
        const invites = await client.invoke(new Api.messages.GetExportedChatInvites({
          peer: sg2Peer,
          adminId: new Api.InputUserSelf(),
          limit: 1,
        }));
        if (invites?.invites?.length > 0) {
          const link = invites.invites[0].link;
          await capture("messages.getChatInviteImporters", new Api.messages.GetChatInviteImporters({
            peer: sg2Peer,
            link: link,
            offsetDate: 0,
            offsetUser: new Api.InputUserEmpty(),
            limit: 10,
          }));
        }
      } catch (e) {
        console.error(`  ❌ getChatInviteImporters: ${e.message}`);
      }

      // channels.inviteToChannel — needs TARGET_USER
      if (TARGET_USER && !SKIP_MUTATIONS) {
        try {
          const targetResolved = await client.invoke(new Api.contacts.ResolveUsername({ username: TARGET_USER }));
          if (targetResolved?.users?.length > 0) {
            const tgtUser = targetResolved.users[0];
            await capture("channels.inviteToChannel", new Api.channels.InviteToChannel({
              channel: sg2Input,
              users: [new Api.InputUser({ userId: tgtUser.id, accessHash: tgtUser.accessHash })],
            }));
          }
        } catch (e) {
          console.error(`  ❌ inviteToChannel: ${e.message}`);
        }
      }

      // channels.deleteChannel (capture the response!)
      console.log(`  Deleting temp supergroup...`);
      await capture("channels.deleteChannel", new Api.channels.DeleteChannel({
        channel: sg2Input,
      }));
    }
  }

  // ── GROUP 21: Chat operations ─────────────────────────────────

  console.log("\n── Group 21: Chat ops ──");

  const g2Title = `_fix_g2_${Date.now()}`;
  console.log(`  Creating temp group "${g2Title}"...`);
  const g2Resp = await client.invoke(new Api.messages.CreateChat({
    users: [new Api.InputUserSelf()],
    title: g2Title,
  }));

  if (g2Resp) {
    let g2ChatId = g2Resp.chats?.[0]?.id || g2Resp.updates?.chats?.[0]?.id;
    if (g2ChatId) {
      // messages.editChatPhoto
      if (!SKIP_MUTATIONS) {
        const pngData2 = Buffer.from(
          "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415478016360f80f000000020001e221bc330000000049454e44ae426082",
          "hex",
        );
        const fileId2 = BigInt(Date.now() + 2);
        await client.invoke(new Api.upload.SaveFilePart({
          fileId: fileId2,
          filePart: 0,
          bytes: pngData2,
        }));
        await capture("messages.editChatPhoto", new Api.messages.EditChatPhoto({
          chatId: g2ChatId,
          photo: new Api.InputChatUploadedPhoto({
            file: new Api.InputFile({
              id: fileId2,
              parts: 1,
              name: "chat_photo.png",
              md5Checksum: "",
            }),
          }),
        }));
      }

      // messages.deleteChat
      console.log(`  Deleting temp group...`);
      await capture("messages.deleteChat", new Api.messages.DeleteChat({
        chatId: g2ChatId,
      }));
    }
  }

  // ── GROUP 22: Message mutations ───────────────────────────────

  if (!SKIP_MUTATIONS && TARGET_USER) {
    console.log("\n── Group 22: Message mutations ──");

    // Resolve target
    const resolvedTarget = await client.invoke(new Api.contacts.ResolveUsername({
      username: TARGET_USER,
    }));
    if (resolvedTarget?.users?.length > 0) {
      const tgtUser = resolvedTarget.users[0];
      const tgtPeer = new Api.InputPeerUser({
        userId: tgtUser.id,
        accessHash: tgtUser.accessHash,
      });

      // messages.setTyping
      await capture("messages.setTyping__user", new Api.messages.SetTyping({
        peer: tgtPeer,
        action: new Api.SendMessageTypingAction(),
      }));

      // messages.toggleDialogPin — pin then unpin
      await capture("messages.toggleDialogPin__pin", new Api.messages.ToggleDialogPin({
        pinned: true,
        peer: new Api.InputDialogPeer({ peer: tgtPeer }),
      }));
      await sleep(200);
      // Unpin immediately
      try {
        await client.invoke(new Api.messages.ToggleDialogPin({
          pinned: false,
          peer: new Api.InputDialogPeer({ peer: tgtPeer }),
        }));
      } catch {}

      // messages.reorderPinnedDialogs
      await capture("messages.reorderPinnedDialogs", new Api.messages.ReorderPinnedDialogs({
        folderId: 0,
        order: [new Api.InputDialogPeer({ peer: tgtPeer })],
        force: true,
      }));
      // Unpin again to clean up
      try {
        await client.invoke(new Api.messages.ToggleDialogPin({
          pinned: false,
          peer: new Api.InputDialogPeer({ peer: tgtPeer }),
        }));
      } catch {}
    }
  }

  // ── GROUP 23: Upload operations ───────────────────────────────

  console.log("\n── Group 23: Upload ──");

  // upload.saveFilePart
  const uploadPng = Buffer.from(
    "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415478016360f80f000000020001e221bc330000000049454e44ae426082",
    "hex",
  );
  const uploadFileId = BigInt(Date.now() + 3);
  await capture("upload.saveFilePart", new Api.upload.SaveFilePart({
    fileId: uploadFileId,
    filePart: 0,
    bytes: uploadPng,
  }));

  // upload.getFile — try to get our own profile photo
  try {
    const me2 = await client.invoke(new Api.users.GetFullUser({ id: new Api.InputUserSelf() }));
    const photo = me2?.fullUser?.profilePhoto;
    if (photo?.id) {
      await capture("upload.getFile__profilePhoto", new Api.upload.GetFile({
        location: new Api.InputPhotoFileLocation({
          id: photo.id,
          accessHash: photo.accessHash,
          fileReference: photo.fileReference || Buffer.alloc(0),
          thumbSize: "c",
        }),
        offset: BigInt(0),
        limit: 1024 * 1024,
      }));
    } else {
      console.log("  [SKIP] upload.getFile: no profile photo");
    }
  } catch (e) {
    console.error(`  ❌ upload.getFile: ${e.message}`);
  }

  // ── GROUP 24: Contacts extras ─────────────────────────────────

  console.log("\n── Group 24: Contacts extras ──");

  // contacts.resolvePhone — try with a known phone if we have one
  try {
    await capture("contacts.resolvePhone", new Api.contacts.ResolvePhone({
      phone: "+79991234567",
    }));
  } catch {}

  // ── GROUP 25: Custom emoji documents ──────────────────────────

  console.log("\n── Group 25: Emoji documents ──");

  // Try to find a custom emoji ID from existing sticker sets
  try {
    const animSet = await client.invoke(new Api.messages.GetStickerSet({
      stickerset: new Api.InputStickerSetAnimatedEmoji(),
      hash: 0,
    }));
    if (animSet?.documents?.length > 0) {
      const docId = animSet.documents[0].id;
      await capture("messages.getCustomEmojiDocuments", new Api.messages.GetCustomEmojiDocuments({
        documentId: [docId],
      }));
    }
  } catch (e) {
    console.error(`  ❌ getCustomEmojiDocuments: ${e.message}`);
  }

  // ── Manifest ──────────────────────────────────────────────────────

  const manifest = {
    capturedAt: new Date().toISOString(),
    fixtureCount,
    errors,
    outputDir: OUTPUT_DIR,
  };
  writeFileSync(join(OUTPUT_DIR, "_manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`\n✅ Done! ${fixtureCount} fixtures → ${OUTPUT_DIR}`);
  if (errors.length > 0) {
    console.log(`  ⚠️  ${errors.length} error(s):`);
    for (const e of errors) console.log(`    - ${e.method}: ${e.error}`);
  }

  await client.disconnect();
}

// ─── Peer helpers ───────────────────────────────────────────────────

function buildPeerKey(peer) {
  if (peer.className === "PeerUser") return `user_${peer.userId}`;
  if (peer.className === "PeerChat") return `chat_${peer.chatId}`;
  if (peer.className === "PeerChannel") return `channel_${peer.channelId}`;
  return "unknown";
}

function buildInputPeer(peer, users, chats) {
  if (peer.className === "PeerUser") {
    const u = users.find((x) => x.id === peer.userId);
    if (!u?.accessHash) return null;
    return new Api.InputPeerUser({ userId: u.id, accessHash: u.accessHash });
  }
  if (peer.className === "PeerChat") {
    return new Api.InputPeerChat({ chatId: peer.chatId });
  }
  if (peer.className === "PeerChannel") {
    const c = chats.find((x) => x.id === peer.channelId);
    if (!c?.accessHash) return null;
    return new Api.InputPeerChannel({ channelId: c.id, accessHash: c.accessHash });
  }
  return null;
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
