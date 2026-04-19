import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Raw } from "telegram/events/index.js";
import readline from "readline";

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
function dumpTlObject(obj, depth = 0, maxDepth = 8) {
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

  const state = await client.invoke(new Api.updates.GetState());
  console.log("\n📊 Update state:", JSON.stringify(dumpTlObject(state), null, 2));

  const me = await client.getMe();
  console.log(`\n👤 ${me.firstName} (ID: ${me.id})`);

  // RAW update handler — captures everything before GramJS processes it
  client.addEventHandler((update) => {
    const ts = new Date().toISOString();
    const cn = update?.className || "unknown";
    console.log("\n" + "═".repeat(80));
    console.log(`[${ts}] RAW UPDATE: ${cn}`);
    console.log("═".repeat(80));
    console.log(JSON.stringify(dumpTlObject(update), null, 2));
    console.log("═".repeat(80) + "\n");
  }, new Raw({}));

  console.log("\n📡 Listening... Commands: send <text> | state | quit");

  while (true) {
    const cmd = await ask("\n> ");
    if (cmd === "quit" || cmd === "exit") break;

    if (cmd === "state") {
      const s = await client.invoke(new Api.updates.GetState());
      console.log(JSON.stringify(dumpTlObject(s), null, 2));
      continue;
    }

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

    if (cmd.startsWith("getmsgs")) {
      // Usage: getmsgs 1401 1402 1403   (message IDs separated by spaces)
      const parts = cmd.split(/\s+/).slice(1);
      const ids = parts.map((id) => new Api.InputMessageID({ id: parseInt(id) }));
      if (!ids.length) {
        console.log("Usage: getmsgs <id1> <id2> ...");
        continue;
      }
      console.log(`\n📥 Calling messages.GetMessages with IDs: ${parts.join(", ")}...`);
      try {
        const result = await client.invoke(new Api.messages.GetMessages({ id: ids }));
        console.log("\n📥 messages.GetMessages RESPONSE:");
        console.log(JSON.stringify(dumpTlObject(result), null, 2));
      } catch (err) {
        console.error("GetMessages error:", err.message);
      }
      continue;
    }

    // ── createchat <title> ──────────────────────────────────────────────────
    // Creates a basic group, captures the Updates response, fetches history
    // (to see the service message), captures getPeerDialogs, then deletes it.
    if (cmd.startsWith("createchat ")) {
      const title = cmd.slice("createchat ".length).trim();
      if (!title) { console.log("Usage: createchat <title>"); continue; }

      let createdChatId = null;

      try {
        console.log(`\n📤 messages.CreateChat title="${title}"...`);
        const createResult = await client.invoke(
          new Api.messages.CreateChat({
            users: [new Api.InputUserSelf()],
            title,
          })
        );
        console.log("\n📥 messages.CreateChat RESPONSE (raw Updates):");
        console.log(JSON.stringify(dumpTlObject(createResult), null, 2));

        // Extract the chat ID from the response
        if (createResult?.chats?.length) {
          createdChatId = createResult.chats[0].id;
        } else if (createResult?.updates) {
          for (const upd of createResult.updates) {
            if (upd?.className === "UpdateChatParticipants" && upd?.participants?.chatId) {
              createdChatId = upd.participants.chatId;
              break;
            }
          }
        }

        if (!createdChatId) {
          console.log("⚠️  Could not determine created chatId from response.");
        } else {
          console.log(`\n✅ Created chat id=${createdChatId}`);

          const peer = new Api.InputPeerChat({ chatId: createdChatId });

          // Fetch full chat info
          console.log("\n📤 messages.GetFullChat...");
          const fullChat = await client.invoke(
            new Api.messages.GetFullChat({ chatId: createdChatId })
          );
          console.log("\n📥 messages.GetFullChat RESPONSE:");
          console.log(JSON.stringify(dumpTlObject(fullChat), null, 2));

          // Fetch dialog state for the new chat
          console.log("\n📤 messages.GetPeerDialogs...");
          const peerDialogs = await client.invoke(
            new Api.messages.GetPeerDialogs({ peers: [peer] })
          );
          console.log("\n📥 messages.GetPeerDialogs RESPONSE:");
          console.log(JSON.stringify(dumpTlObject(peerDialogs), null, 2));

          // Fetch message history (service message should be msg id=1)
          console.log("\n📤 messages.GetHistory (limit 5)...");
          const history = await client.invoke(
            new Api.messages.GetHistory({
              peer,
              offsetId: 0,
              offsetDate: 0,
              addOffset: 0,
              limit: 5,
              maxId: 0,
              minId: 0,
              hash: BigInt(0),
            })
          );
          console.log("\n📥 messages.GetHistory RESPONSE:");
          console.log(JSON.stringify(dumpTlObject(history), null, 2));

          // Also call messages.GetMessages for msgId=1 to see service message directly
          console.log("\n📤 messages.GetMessages id=1...");
          const msg1 = await client.invoke(
            new Api.messages.GetMessages({
              id: [new Api.InputMessageID({ id: 1 })],
            })
          );
          console.log("\n📥 messages.GetMessages(id=1) RESPONSE:");
          console.log(JSON.stringify(dumpTlObject(msg1), null, 2));
        }
      } catch (err) {
        console.error("createchat error:", err.message);
      }

      // Offer to delete
      if (createdChatId) {
        const del = await ask(`\nDelete the test chat (id=${createdChatId})? [y/N] `);
        if (del.trim().toLowerCase() === "y") {
          try {
            await client.invoke(
              new Api.messages.DeleteChat({ chatId: createdChatId })
            );
            console.log("🗑️  Chat deleted.");
          } catch (err) {
            console.error("deleteChat error:", err.message);
          }
        }
      }
      continue;
    }

    // ── createchannel <title> ───────────────────────────────────────────────
    // Creates a supergroup/channel, captures response, fetches history, deletes.
    if (cmd.startsWith("createchannel ")) {
      const title = cmd.slice("createchannel ".length).trim();
      if (!title) { console.log("Usage: createchannel <title>"); continue; }

      let createdChannelId = null;
      let createdAccessHash = null;

      try {
        console.log(`\n📤 channels.CreateChannel title="${title}"...`);
        const createResult = await client.invoke(
          new Api.channels.CreateChannel({
            title,
            about: "",
            megagroup: true,
          })
        );
        console.log("\n📥 channels.CreateChannel RESPONSE (raw Updates):");
        console.log(JSON.stringify(dumpTlObject(createResult), null, 2));

        if (createResult?.chats?.length) {
          createdChannelId = createResult.chats[0].id;
          createdAccessHash = createResult.chats[0].accessHash;
        }

        if (!createdChannelId) {
          console.log("⚠️  Could not determine created channelId from response.");
        } else {
          console.log(`\n✅ Created channel id=${createdChannelId}`);

          const peer = new Api.InputPeerChannel({
            channelId: createdChannelId,
            accessHash: createdAccessHash,
          });

          // Fetch full channel info
          console.log("\n📤 channels.GetFullChannel...");
          const fullChannel = await client.invoke(
            new Api.channels.GetFullChannel({
              channel: new Api.InputChannel({
                channelId: createdChannelId,
                accessHash: createdAccessHash,
              }),
            })
          );
          console.log("\n📥 channels.GetFullChannel RESPONSE:");
          console.log(JSON.stringify(dumpTlObject(fullChannel), null, 2));

          // Fetch dialog state for the new channel
          console.log("\n📤 messages.GetPeerDialogs...");
          const peerDialogs = await client.invoke(
            new Api.messages.GetPeerDialogs({ peers: [peer] })
          );
          console.log("\n📥 messages.GetPeerDialogs RESPONSE:");
          console.log(JSON.stringify(dumpTlObject(peerDialogs), null, 2));

          // Fetch message history
          console.log("\n📤 messages.GetHistory (limit 5)...");
          const history = await client.invoke(
            new Api.messages.GetHistory({
              peer,
              offsetId: 0,
              offsetDate: 0,
              addOffset: 0,
              limit: 5,
              maxId: 0,
              minId: 0,
              hash: BigInt(0),
            })
          );
          console.log("\n📥 messages.GetHistory RESPONSE:");
          console.log(JSON.stringify(dumpTlObject(history), null, 2));
        }
      } catch (err) {
        console.error("createchannel error:", err.message);
      }

      if (createdChannelId) {
        const del = await ask(`\nDelete the test channel (id=${createdChannelId})? [y/N] `);
        if (del.trim().toLowerCase() === "y") {
          try {
            await client.invoke(
              new Api.channels.DeleteChannel({
                channel: new Api.InputChannel({
                  channelId: createdChannelId,
                  accessHash: createdAccessHash,
                }),
              })
            );
            console.log("🗑️  Channel deleted.");
          } catch (err) {
            console.error("deleteChannel error:", err.message);
          }
        }
      }
      continue;
    }

    console.log("Commands: send <text> | getmsgs <id1> <id2> ... | createchat <title> | createchannel <title> | state | quit");
  }

  await client.disconnect();
  rl.close();
}

main().catch(console.error);
