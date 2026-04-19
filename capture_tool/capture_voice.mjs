import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Raw } from "telegram/events/index.js";
import readline from "readline";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";

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

const OUTPUT_DIR = resolve("output/voice_capture");
mkdirSync(OUTPUT_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════════
function dumpTlObject(obj, depth = 0, maxDepth = 10) {
  if (depth > maxDepth) return "[max depth]";
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "bigint") return `BigInt(${obj})`;
  if (typeof obj !== "object") return obj;
  if (Buffer.isBuffer(obj)) return `Buffer(${obj.length})[${obj.toString("hex").slice(0, 128)}...]`;
  if (obj instanceof Uint8Array) return `Uint8Array(${obj.length})[${Buffer.from(obj).toString("hex").slice(0, 128)}...]`;

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

  // RAW update handler — captures voice messages in updates
  client.addEventHandler((update) => {
    const ts = new Date().toISOString();
    const cn = update?.className || "unknown";

    // Check if it's a message update containing a voice message
    if (cn === "UpdateNewMessage" || cn === "UpdateShortMessage") {
      const msg = update.message;
      if (msg && msg.media && msg.media.className === "MessageMediaDocument") {
        const doc = msg.media.document;
        if (doc && doc.attributes) {
          for (const attr of doc.attributes) {
            if (attr.className === "DocumentAttributeAudio" && attr.voice) {
              console.log("\n" + "═".repeat(80));
              console.log(`[${ts}] 🎤 VOICE MESSAGE RECEIVED!`);
              console.log("═".repeat(80));
              console.log(JSON.stringify(dumpTlObject(update), null, 2));
              console.log("═".repeat(80) + "\n");

              // Save capture
              const filename = `voice_update_${Date.now()}.json`;
              writeFileSync(
                resolve(OUTPUT_DIR, filename),
                JSON.stringify(dumpTlObject(update), null, 2)
              );
              console.log(`💾 Saved to ${filename}`);
              return;
            }
          }
        }
      }
    }

    // Log other updates briefly
    if (cn.includes("Message") || cn.includes("Status")) {
      console.log(`[${ts}] ${cn}`);
    }
  }, new Raw({}));

  console.log("\n📡 Voice Message Capture Commands:");
  console.log("  sendvoice <userId> <oggFile> [caption]  — send voice message");
  console.log("  history <userId>                         — get history (find voice msgs)");
  console.log("  download <msgId> <userId>                — download voice from message");
  console.log("  quit                                     — exit");

  while (true) {
    const cmd = await ask("\n> ");
    if (cmd === "quit" || cmd === "exit") break;

    // ─── Send voice message ───
    if (cmd.startsWith("sendvoice ")) {
      const parts = cmd.slice(10).trim().split(/\s+/);
      const userId = parts[0];
      const filePath = parts[1];
      const caption = parts.slice(2).join(" ") || "";
      if (!userId || !filePath) {
        console.log("Usage: sendvoice <userId> <oggFile> [caption]");
        continue;
      }
      if (!existsSync(filePath)) {
        console.log(`File not found: ${filePath}`);
        continue;
      }
      console.log(`\n🎤 Sending voice ${filePath} to user ${userId}...`);
      try {
        const entity = await client.getInputEntity(BigInt(userId));
        const result = await client.sendFile(entity, {
          file: filePath,
          voiceNote: true,
          caption: caption,
        });
        console.log("\n📥 SendVoice RESPONSE:");
        const dumped = dumpTlObject(result);
        console.log(JSON.stringify(dumped, null, 2));

        const filename = `sendvoice_response_${Date.now()}.json`;
        writeFileSync(resolve(OUTPUT_DIR, filename), JSON.stringify(dumped, null, 2));
        console.log(`💾 Saved to ${filename}`);
      } catch (err) {
        console.error("SendVoice error:", err.message);
      }
      continue;
    }

    // ─── Get history (look for voice messages) ───
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
            limit: 50,
            maxId: 0,
            minId: 0,
            hash: BigInt(0),
          })
        );

        const dumped = dumpTlObject(result);

        // Find voice messages
        let voiceCount = 0;
        if (result.messages) {
          for (const msg of result.messages) {
            if (msg.media && msg.media.className === "MessageMediaDocument") {
              const doc = msg.media.document;
              if (doc && doc.attributes) {
                for (const attr of doc.attributes) {
                  if (attr.className === "DocumentAttributeAudio" && attr.voice) {
                    voiceCount++;
                    console.log(`\n🎤 Voice msg #${msg.id} (${attr.duration}s):`);
                    console.log(JSON.stringify(dumpTlObject(msg), null, 2));
                  }
                }
              }
            }
          }
        }

        console.log(`\n📊 Found ${voiceCount} voice messages in last 50`);

        const filename = `history_${userId}_${Date.now()}.json`;
        writeFileSync(resolve(OUTPUT_DIR, filename), JSON.stringify(dumped, null, 2));
        console.log(`💾 Full history saved to ${filename}`);
      } catch (err) {
        console.error("GetHistory error:", err.message);
      }
      continue;
    }

    // ─── Download voice message file ───
    if (cmd.startsWith("download ")) {
      const parts = cmd.slice(9).trim().split(/\s+/);
      const msgId = parseInt(parts[0]);
      const userId = parts[1];
      if (!msgId || !userId) {
        console.log("Usage: download <msgId> <userId>");
        continue;
      }
      console.log(`\n⬇️ Downloading media from msg ${msgId}...`);
      try {
        const entity = await client.getInputEntity(BigInt(userId));
        const result = await client.invoke(
          new Api.messages.GetHistory({
            peer: entity,
            offsetId: msgId + 1,
            offsetDate: 0,
            addOffset: 0,
            limit: 1,
            maxId: msgId + 1,
            minId: msgId - 1,
            hash: BigInt(0),
          })
        );

        const msg = result.messages.find(m => m.id === msgId);
        if (!msg?.media) {
          console.log("Message not found or has no media");
          continue;
        }

        const buffer = await client.downloadMedia(msg.media, {});
        const outFile = resolve(OUTPUT_DIR, `voice_${msgId}.ogg`);
        writeFileSync(outFile, buffer);
        console.log(`💾 Downloaded ${buffer.length} bytes to ${outFile}`);
      } catch (err) {
        console.error("Download error:", err.message);
      }
      continue;
    }

    console.log("Unknown command. Use: sendvoice, history, download, quit");
  }

  await client.disconnect();
  rl.close();
}

main().catch(console.error);
