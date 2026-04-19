import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Raw } from "telegram/events/index.js";
import readline from "readline";
import { existsSync } from "fs";

// ═══════════════════════════════════════════════════════════════
const API_ID = parseInt(process.env.TG_API_ID || "0");
const API_HASH = process.env.TG_API_HASH || "";
const SESSION_STRING = process.env.TG_SESSION || "";

if (!API_ID || !API_HASH) {
  console.error("Set TG_API_ID and TG_API_HASH environment variables");
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

// ═══════════════════════════════════════════════════════════════
// Deep-dump a GramJS object recursively
// ═══════════════════════════════════════════════════════════════
function dumpTlObject(obj, depth = 0, maxDepth = 10) {
  if (depth > maxDepth) return "[max depth]";
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "bigint") return `BigInt(${obj})`;
  if (typeof obj !== "object") return obj;
  if (Buffer.isBuffer(obj)) return `Buffer(${obj.length})[${obj.toString("hex").slice(0, 64)}...]`;
  if (obj instanceof Uint8Array) return `Uint8Array(${obj.length})`;

  if (Array.isArray(obj)) {
    return obj.map((item) => dumpTlObject(item, depth + 1, maxDepth));
  }

  const result = {};
  if (obj.className) result._class = obj.className;
  if (obj.CONSTRUCTOR_ID !== undefined)
    result._cid = "0x" + (obj.CONSTRUCTOR_ID >>> 0).toString(16).padStart(8, "0");

  for (const key of Object.keys(obj)) {
    if (key.startsWith("_") || key === "CONSTRUCTOR_ID" || key === "SUBCLASS_OF_ID" || key === "classType") continue;
    try {
      result[key] = dumpTlObject(obj[key], depth + 1, maxDepth);
    } catch {
      result[key] = "[error]";
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
async function main() {
  const session = new StringSession(SESSION_STRING);
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await ask("Phone number: "),
    password: async () => await ask("2FA password (or enter to skip): "),
    phoneCode: async () => await ask("Code from Telegram: "),
    onError: (err) => console.error("Auth error:", err),
  });

  console.log("\n✅ Logged in!");
  console.log("Session string (save for reuse):");
  console.log(client.session.save());

  const me = await client.getMe();
  console.log(`\n👤 ${me.firstName} (ID: ${me.id})`);

  // Pre-load entity cache from dialogs
  console.log("📂 Loading dialogs to populate entity cache...");
  const dialogs = await client.getDialogs({ limit: 100 });
  console.log(`   Cached ${dialogs.length} dialog entities`);

  // RAW update handler
  client.addEventHandler((update) => {
    const ts = new Date().toISOString();
    const cn = update?.className || "unknown";
    console.log("\n" + "═".repeat(80));
    console.log(`[${ts}] RAW UPDATE: ${cn}`);
    console.log("═".repeat(80));
    console.log(JSON.stringify(dumpTlObject(update), null, 2));
    console.log("═".repeat(80) + "\n");
  }, new Raw({}));

  console.log("\n📡 Commands:");
  console.log("  search <query>          — contacts.search");
  console.log("  resolve <username>      — contacts.resolveUsername");
  console.log("  sendto <userId> <text>  — messages.sendMessage to user");
  console.log("  send <text>             — messages.sendMessage to Saved Messages");
  console.log("  dialogs                 — messages.getDialogs");
  console.log("  history <userId>        — messages.getHistory for user");
  console.log("  reply <userId> <msgId> <text>  — reply to a message");
  console.log("  quote <userId> <msgId> <offset> <len> <text> — reply with quote");
  console.log("  sendphoto <userId> <path> [caption] — send photo");
  console.log("  sendfile <userId> <path> [caption]  — send document/file");
  console.log("  edit <userId> <msgId> <newText> — messages.editMessage");
  console.log("  delete [--revoke] <id1> <id2>  — messages.deleteMessages");
  console.log("  getmsgs <id1> <id2>     — messages.getMessages");
  console.log("  state                   — updates.getState");
  console.log("  quit                    — exit");

  while (true) {
    const cmd = await ask("\n> ");
    if (cmd === "quit" || cmd === "exit") break;

    // ─── contacts.search ───
    if (cmd.startsWith("search ")) {
      const query = cmd.slice(7).trim();
      console.log(`\n🔍 contacts.search("${query}")...`);
      try {
        const result = await client.invoke(
          new Api.contacts.Search({ q: query, limit: 10 })
        );
        console.log("\n📥 contacts.Search RESPONSE:");
        console.log(JSON.stringify(dumpTlObject(result), null, 2));
      } catch (err) {
        console.error("Search error:", err.message);
      }
      continue;
    }

    // ─── contacts.resolveUsername ───
    if (cmd.startsWith("resolve ")) {
      const username = cmd.slice(8).trim();
      console.log(`\n🔍 contacts.resolveUsername("${username}")...`);
      try {
        const result = await client.invoke(
          new Api.contacts.ResolveUsername({ username })
        );
        console.log("\n📥 contacts.ResolveUsername RESPONSE:");
        console.log(JSON.stringify(dumpTlObject(result), null, 2));
      } catch (err) {
        console.error("Resolve error:", err.message);
      }
      continue;
    }

    // ─── messages.sendMessage to specific user ───
    if (cmd.startsWith("sendto ")) {
      const parts = cmd.slice(7).trim().split(/\s+/);
      const userId = parts[0];
      const text = parts.slice(1).join(" ");
      if (!userId || !text) {
        console.log("Usage: sendto <userId> <text>");
        continue;
      }
      console.log(`\n📤 Sending "${text}" to user ${userId}...`);
      try {
        // First resolve the user entity
        const entity = await client.getInputEntity(BigInt(userId));
        const result = await client.invoke(
          new Api.messages.SendMessage({
            peer: entity,
            message: text,
            randomId: BigInt(Math.floor(Math.random() * 2 ** 62)),
          })
        );
        console.log("\n📥 SendMessage RESPONSE:");
        console.log(JSON.stringify(dumpTlObject(result), null, 2));
      } catch (err) {
        console.error("Send error:", err.message);
      }
      continue;
    }

    // ─── messages.sendMessage to Saved Messages ───
    if (cmd.startsWith("send ")) {
      const text = cmd.slice(5);
      console.log(`\n📤 Sending "${text}" to Saved Messages...`);
      try {
        const result = await client.invoke(
          new Api.messages.SendMessage({
            peer: new Api.InputPeerSelf(),
            message: text,
            randomId: BigInt(Math.floor(Math.random() * 2 ** 62)),
          })
        );
        console.log("\n📥 SendMessage RESPONSE:");
        console.log(JSON.stringify(dumpTlObject(result), null, 2));
      } catch (err) {
        console.error("Send error:", err.message);
      }
      continue;
    }

    // ─── messages.getDialogs ───
    if (cmd === "dialogs") {
      console.log("\n📥 messages.getDialogs...");
      try {
        const result = await client.invoke(
          new Api.messages.GetDialogs({
            offsetDate: 0,
            offsetId: 0,
            offsetPeer: new Api.InputPeerEmpty(),
            limit: 20,
            hash: BigInt(0),
          })
        );
        console.log("\n📥 messages.GetDialogs RESPONSE:");
        console.log(JSON.stringify(dumpTlObject(result), null, 2));
      } catch (err) {
        console.error("GetDialogs error:", err.message);
      }
      continue;
    }

    // ─── messages.getHistory for a user ───
    if (cmd.startsWith("history ")) {
      const userId = cmd.slice(8).trim();
      console.log(`\n📥 messages.getHistory for user ${userId}...`);
      try {
        const entity = await client.getInputEntity(BigInt(userId));
        const result = await client.invoke(
          new Api.messages.GetHistory({
            peer: entity,
            offsetId: 0,
            offsetDate: 0,
            addOffset: 0,
            limit: 20,
            maxId: 0,
            minId: 0,
            hash: BigInt(0),
          })
        );
        console.log("\n📥 messages.GetHistory RESPONSE:");
        console.log(JSON.stringify(dumpTlObject(result), null, 2));
      } catch (err) {
        console.error("GetHistory error:", err.message);
      }
      continue;
    }

    // ─── messages.sendMessage with reply ───
    if (cmd.startsWith("reply ")) {
      const parts = cmd.slice(6).trim().split(/\s+/);
      const userId = parts[0];
      const msgId = parseInt(parts[1]);
      const text = parts.slice(2).join(" ");
      if (!userId || !msgId || !text) {
        console.log("Usage: reply <userId> <msgId> <text>");
        continue;
      }
      console.log(`\n↩️ Replying to msg ${msgId} in chat with user ${userId}: "${text}"...`);
      try {
        const entity = await client.getInputEntity(BigInt(userId));
        const result = await client.invoke(
          new Api.messages.SendMessage({
            peer: entity,
            replyTo: new Api.InputReplyToMessage({
              replyToMsgId: msgId,
            }),
            message: text,
            randomId: BigInt(Math.floor(Math.random() * 2 ** 62)),
          })
        );
        console.log("\n📥 SendMessage (reply) RESPONSE:");
        console.log(JSON.stringify(dumpTlObject(result), null, 2));
      } catch (err) {
        console.error("Reply error:", err.message);
      }
      continue;
    }

    // ─── messages.sendMessage with reply + quote ───
    if (cmd.startsWith("quote ")) {
      const parts = cmd.slice(6).trim().split(/\s+/);
      const userId = parts[0];
      const msgId = parseInt(parts[1]);
      const quoteOffset = parseInt(parts[2]);
      const quoteLen = parseInt(parts[3]);
      const text = parts.slice(4).join(" ");
      if (!userId || !msgId || !text || isNaN(quoteOffset) || isNaN(quoteLen)) {
        console.log("Usage: quote <userId> <msgId> <quoteOffset> <quoteLen> <text>");
        console.log("  First use 'history <userId>' to find the message, then specify");
        console.log("  the offset and length of the substring you want to quote.");
        continue;
      }

      // Fetch the original message to extract the quote text
      const histMsgs = await client.invoke(
        new Api.messages.GetMessages({ id: [new Api.InputMessageID({ id: msgId })] })
      );
      const origMsg = histMsgs.messages?.[0];
      const origText = origMsg?.message || "";
      const quoteText = origText.substring(quoteOffset, quoteOffset + quoteLen);
      if (!quoteText) {
        console.log(`⚠️ Could not extract quote from message ${msgId} (text: "${origText}")`);
        console.log(`   offset=${quoteOffset}, len=${quoteLen}`);
        continue;
      }

      console.log(`\n💬 Quote-replying to msg ${msgId}: quote="${quoteText}", reply="${text}"...`);
      try {
        const entity = await client.getInputEntity(BigInt(userId));
        const result = await client.invoke(
          new Api.messages.SendMessage({
            peer: entity,
            replyTo: new Api.InputReplyToMessage({
              replyToMsgId: msgId,
              quoteText: quoteText,
              quoteOffset: quoteOffset,
            }),
            message: text,
            randomId: BigInt(Math.floor(Math.random() * 2 ** 62)),
          })
        );
        console.log("\n📥 SendMessage (quote-reply) RESPONSE:");
        console.log(JSON.stringify(dumpTlObject(result), null, 2));
      } catch (err) {
        console.error("Quote-reply error:", err.message);
      }
      continue;
    }

    // ─── messages.editMessage ───
    if (cmd.startsWith("edit ")) {
      const parts = cmd.slice(5).trim().split(/\s+/);
      const userId = parts[0];
      const msgId = parseInt(parts[1]);
      const newText = parts.slice(2).join(" ");
      if (!userId || !msgId || !newText) {
        console.log("Usage: edit <userId> <msgId> <newText>");
        continue;
      }
      console.log(`\n✏️ Editing msg ${msgId} in chat with user ${userId} to "${newText}"...`);
      try {
        const entity = await client.getInputEntity(BigInt(userId));
        const result = await client.invoke(
          new Api.messages.EditMessage({
            peer: entity,
            id: msgId,
            message: newText,
          })
        );
        console.log("\n📥 EditMessage RESPONSE:");
        console.log(JSON.stringify(dumpTlObject(result), null, 2));
      } catch (err) {
        console.error("Edit error:", err.message);
      }
      continue;
    }

    // ─── messages.deleteMessages ───
    if (cmd.startsWith("delete ")) {
      const parts = cmd.slice(7).trim().split(/\s+/);
      const revoke = parts[0] === "--revoke";
      const ids = (revoke ? parts.slice(1) : parts).map((id) => parseInt(id));
      if (!ids.length || ids.some(isNaN)) {
        console.log("Usage: delete [--revoke] <id1> <id2> ...");
        continue;
      }
      console.log(`\n🗑️ Deleting messages ${ids.join(", ")} (revoke=${revoke})...`);
      try {
        const result = await client.invoke(
          new Api.messages.DeleteMessages({
            id: ids,
            revoke: revoke,
          })
        );
        console.log("\n📥 DeleteMessages RESPONSE:");
        console.log(JSON.stringify(dumpTlObject(result), null, 2));
      } catch (err) {
        console.error("Delete error:", err.message);
      }
      continue;
    }

    // ─── messages.getMessages ───
    if (cmd.startsWith("getmsgs")) {
      const parts = cmd.split(/\s+/).slice(1);
      const ids = parts.map((id) => new Api.InputMessageID({ id: parseInt(id) }));
      if (!ids.length) {
        console.log("Usage: getmsgs <id1> <id2> ...");
        continue;
      }
      console.log(`\n📥 messages.GetMessages with IDs: ${parts.join(", ")}...`);
      try {
        const result = await client.invoke(new Api.messages.GetMessages({ id: ids }));
        console.log("\n📥 messages.GetMessages RESPONSE:");
        console.log(JSON.stringify(dumpTlObject(result), null, 2));
      } catch (err) {
        console.error("GetMessages error:", err.message);
      }
      continue;
    }

    // ─── updates.getState ───
    if (cmd === "state") {
      const s = await client.invoke(new Api.updates.GetState());
      console.log(JSON.stringify(dumpTlObject(s), null, 2));
      continue;
    }

    // ─── messages.sendMedia (photo) ───
    if (cmd.startsWith("sendphoto ")) {
      const parts = cmd.slice(10).trim().split(/\s+/);
      const userId = parts[0];
      const filePath = parts[1];
      const caption = parts.slice(2).join(" ") || "";
      if (!userId || !filePath) {
        console.log("Usage: sendphoto <userId> <filePath> [caption]");
        continue;
      }
      if (!existsSync(filePath)) {
        console.log(`File not found: ${filePath}`);
        continue;
      }
      console.log(`\n📸 Sending photo ${filePath} to user ${userId}...`);
      try {
        const entity = await client.getInputEntity(BigInt(userId));
        const result = await client.invoke(
          new Api.messages.SendMedia({
            peer: entity,
            media: new Api.InputMediaUploadedPhoto({
              file: await client.uploadFile({
                file: new Api.client.uploads.CustomFile(filePath, (await import("fs")).statSync(filePath).size, filePath),
                workers: 1,
              }),
            }),
            message: caption,
            randomId: BigInt(Math.floor(Math.random() * 2 ** 62)),
          })
        );
        console.log("\n📥 SendMedia (photo) RESPONSE:");
        console.log(JSON.stringify(dumpTlObject(result), null, 2));
      } catch (err) {
        console.error("SendPhoto error:", err.message);
        // Fallback: use client.sendFile which handles upload internally
        console.log("Trying client.sendFile fallback...");
        try {
          const result = await client.sendFile(BigInt(userId), {
            file: filePath,
            caption: caption,
            forceDocument: false,
          });
          console.log("\n📥 sendFile (photo) RESPONSE:");
          console.log(JSON.stringify(dumpTlObject(result), null, 2));
        } catch (err2) {
          console.error("sendFile fallback error:", err2.message);
        }
      }
      continue;
    }

    // ─── messages.sendMedia (document) ───
    if (cmd.startsWith("sendfile ")) {
      const parts = cmd.slice(9).trim().split(/\s+/);
      const userId = parts[0];
      const filePath = parts[1];
      const caption = parts.slice(2).join(" ") || "";
      if (!userId || !filePath) {
        console.log("Usage: sendfile <userId> <filePath> [caption]");
        continue;
      }
      if (!existsSync(filePath)) {
        console.log(`File not found: ${filePath}`);
        continue;
      }
      console.log(`\n📎 Sending file ${filePath} to user ${userId}...`);
      try {
        const result = await client.sendFile(BigInt(userId), {
          file: filePath,
          caption: caption,
          forceDocument: true,
        });
        console.log("\n📥 sendFile (document) RESPONSE:");
        console.log(JSON.stringify(dumpTlObject(result), null, 2));
      } catch (err) {
        console.error("SendFile error:", err.message);
      }
      continue;
    }

    console.log("Unknown command.");
  }

  await client.disconnect();
  rl.close();
}

main().catch(console.error);
