/**
 * capture_profile.mjs — captures real Telegram server responses for profile-editing methods:
 *   account.checkUsername
 *   account.updateUsername
 *   photos.uploadProfilePhoto
 *
 * Usage:
 *   TG_API_ID=... TG_API_HASH=... TG_SESSION=... node capture_profile.mjs
 *
 * Interactive commands:
 *   checkusername <username>   — account.checkUsername
 *   setusername <username>     — account.updateUsername  (sets your username)
 *   clearusername              — account.updateUsername with empty string (removes username)
 *   uploadphoto <path>         — photos.uploadProfilePhoto (upload & set profile photo)
 *   me                         — show current account info (users.getFullUser on self)
 *   quit
 */

import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Raw } from "telegram/events/index.js";
import readline from "readline";
import { readFileSync, existsSync } from "fs";

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

function section(title) {
  console.log("\n" + "═".repeat(70));
  console.log(`  ${title}`);
  console.log("═".repeat(70));
}

function printResponse(label, result) {
  section(`RESPONSE: ${label}`);
  console.log(JSON.stringify(dumpTlObject(result), null, 2));
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
  const savedSession = client.session.save();
  if (savedSession && !SESSION_STRING) {
    console.log("Session string (save for reuse):");
    console.log(savedSession);
  }

  const me = await client.getMe();
  console.log(`\n👤 Logged in as: ${me.firstName} ${me.lastName || ""} (ID: ${me.id})`);
  if (me.username) {
    console.log(`   Username: @${me.username}`);
  } else {
    console.log("   Username: (none)");
  }

  // Capture all raw updates
  client.addEventHandler((update) => {
    const cn = update?.className || "unknown";
    console.log(`\n[RAW UPDATE: ${cn}]`);
    console.log(JSON.stringify(dumpTlObject(update), null, 2));
  }, new Raw({}));

  console.log(`
Commands:
  checkusername <username>   — account.checkUsername
  setusername <username>     — account.updateUsername (set your username)
  clearusername              — account.updateUsername with "" (remove username)
  uploadphoto <path>         — photos.uploadProfilePhoto
  me                         — users.getFullUser (show current self info)
  quit
`);

  while (true) {
    const cmd = (await ask("> ")).trim();
    if (!cmd) continue;
    if (cmd === "quit" || cmd === "exit") break;

    // ── me ────────────────────────────────────────────────────────────────
    if (cmd === "me") {
      section("INVOKE: users.getFullUser (InputUserSelf)");
      try {
        const result = await client.invoke(
          new Api.users.GetFullUser({ id: new Api.InputUserSelf() })
        );
        printResponse("users.GetFullUser", result);
      } catch (err) {
        console.error("Error:", err.message);
      }
      continue;
    }

    // ── checkusername ─────────────────────────────────────────────────────
    if (cmd.startsWith("checkusername ")) {
      const username = cmd.slice("checkusername ".length).trim();
      if (!username) { console.log("Usage: checkusername <username>"); continue; }
      section(`INVOKE: account.checkUsername("${username}")`);
      try {
        const result = await client.invoke(
          new Api.account.CheckUsername({ username })
        );
        printResponse("account.checkUsername", result);
        // result is Bool (true = available, false = occupied)
        console.log(`\n→ Username "${username}" is ${result ? "AVAILABLE ✅" : "TAKEN ❌"}`);
      } catch (err) {
        console.error("Error:", err.message);
        console.log("(RPC error details above — may indicate USERNAME_INVALID, etc.)");
      }
      continue;
    }

    // ── setusername ───────────────────────────────────────────────────────
    if (cmd.startsWith("setusername ")) {
      const username = cmd.slice("setusername ".length).trim();
      if (!username) { console.log("Usage: setusername <username>"); continue; }
      section(`INVOKE: account.updateUsername("${username}")`);
      console.log("⚠️  NOTE: This will actually change your username on the real account!");
      const confirm = await ask("Confirm? [y/N] ");
      if (confirm.trim().toLowerCase() !== "y") { console.log("Aborted."); continue; }
      try {
        const result = await client.invoke(
          new Api.account.UpdateUsername({ username })
        );
        // Returns User
        printResponse("account.updateUsername", result);
      } catch (err) {
        console.error("Error:", err.message);
      }
      continue;
    }

    // ── clearusername ─────────────────────────────────────────────────────
    if (cmd === "clearusername") {
      section('INVOKE: account.updateUsername("")');
      console.log("⚠️  NOTE: This will remove your username from the real account!");
      const confirm = await ask("Confirm? [y/N] ");
      if (confirm.trim().toLowerCase() !== "y") { console.log("Aborted."); continue; }
      try {
        const result = await client.invoke(
          new Api.account.UpdateUsername({ username: "" })
        );
        printResponse("account.updateUsername (clear)", result);
      } catch (err) {
        console.error("Error:", err.message);
      }
      continue;
    }

    // ── uploadphoto ───────────────────────────────────────────────────────
    if (cmd.startsWith("uploadphoto ")) {
      const filePath = cmd.slice("uploadphoto ".length).trim();
      if (!existsSync(filePath)) {
        console.log(`File not found: ${filePath}`);
        continue;
      }
      section(`INVOKE: photos.uploadProfilePhoto (file: ${filePath})`);
      try {
        // Step 1: upload file parts (upload.saveBigFilePart / upload.saveFilePart)
        console.log("📤 Uploading file...");
        const fileData = readFileSync(filePath);
        const inputFile = await client.uploadFile({
          file: {
            name: filePath.split("/").pop() || "photo.jpg",
            size: fileData.length,
            stream: (function* () { yield fileData; })(),
          },
          workers: 1,
        });
        console.log("\n📥 uploadFile result (InputFile):");
        printResponse("uploadFile (InputFile)", inputFile);

        // Step 2: photos.uploadProfilePhoto
        console.log("\n📤 Calling photos.uploadProfilePhoto...");
        const result = await client.invoke(
          new Api.photos.UploadProfilePhoto({ file: inputFile })
        );
        printResponse("photos.uploadProfilePhoto", result);

        // The result is photos.Photo = { photo: Photo, users: Vector<User> }
        console.log(`\n→ New photo ID: ${result?.photo?.id}`);

        // Step 3: photos.getUserPhotos (immediate call after upload to capture response)
        console.log("\n📤 Calling photos.getUserPhotos on self (offset=0, limit=5)...");
        try {
          const photosResult = await client.invoke(
            new Api.photos.GetUserPhotos({
              userId: new Api.InputUserSelf(),
              offset: 0,
              maxId: BigInt(0),
              limit: 5,
            })
          );
          printResponse("photos.getUserPhotos (after upload)", photosResult);
        } catch (photosErr) {
          console.error("getUserPhotos error:", photosErr.message);
        }
      } catch (err) {
        console.error("Error:", err.message);
        console.error(err);
      }
      continue;
    }

    // ── getphotos ─────────────────────────────────────────────────────────
    if (cmd.startsWith("getphotos") ) {
      // getphotos           — self
      // getphotos <userId>  — another user (needs access hash in local entity cache)
      const parts = cmd.split(/\s+/);
      const targetArg = parts[1];
      section(`INVOKE: photos.getUserPhotos (${targetArg || "self"}, offset=0, limit=100)`);
      try {
        let userId;
        if (!targetArg) {
          userId = new Api.InputUserSelf();
        } else {
          // Try to resolve via getFullUser first to populate entity cache
          userId = await client.getInputEntity(targetArg);
        }
        const result = await client.invoke(
          new Api.photos.GetUserPhotos({
            userId,
            offset: 0,
            maxId: BigInt(0),
            limit: 100,
          })
        );
        printResponse("photos.getUserPhotos", result);
        const photoList = result?.photos || [];
        console.log(`\n→ Total photos: ${result?.count ?? photoList.length}`);
        for (const p of photoList) {
          console.log(`   photo id=${p.id} date=${p.date} hasStickers=${p.hasStickers}`);
        }
      } catch (err) {
        console.error("Error:", err.message);
      }
      continue;
    }

    console.log("Commands: checkusername | setusername | clearusername | uploadphoto | getphotos [userId] | me | quit");
  }

  await client.disconnect();
  rl.close();
}

main().catch(console.error);
