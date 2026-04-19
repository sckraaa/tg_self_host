import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

// ═══════════════════════════════════════════════════════════════
const API_ID = parseInt(process.env.TG_API_ID || "0");
const API_HASH = process.env.TG_API_HASH || "";
const SESSION_STRING = process.env.TG_SESSION || "";
const SEARCH_QUERY = process.env.SEARCH_QUERY || "hello";

if (!API_ID || !API_HASH) {
  console.error("Set TG_API_ID and TG_API_HASH environment variables");
  process.exit(1);
}

function dumpTlObject(obj, depth = 0, maxDepth = 12) {
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

async function main() {
  const session = new StringSession(SESSION_STRING);
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
  });

  await client.connect();
  const me = await client.getMe();
  console.log(`👤 ${me.firstName} (ID: ${me.id})\n`);

  // Load dialogs to populate entity cache
  console.log("📂 Loading dialogs...");
  const dialogs = await client.getDialogs({ limit: 50 });
  console.log(`   Cached ${dialogs.length} dialogs\n`);

  const q = SEARCH_QUERY;

  // ── 1. messages.Search in Saved Messages (InputPeerSelf) ──
  console.log(`\n${"═".repeat(80)}`);
  console.log(`🔍 messages.Search(peer=InputPeerSelf, q="${q}", limit=5)`);
  console.log("═".repeat(80));
  try {
    const result = await client.invoke(
      new Api.messages.Search({
        peer: new Api.InputPeerSelf(),
        q,
        filter: new Api.InputMessagesFilterEmpty(),
        minDate: 0,
        maxDate: 0,
        offsetId: 0,
        addOffset: 0,
        limit: 5,
        maxId: 0,
        minId: 0,
        hash: BigInt(0),
      })
    );
    console.log(JSON.stringify(dumpTlObject(result), null, 2));
  } catch (err) {
    console.error("messages.Search (self) error:", err.message);
  }

  // ── 2. messages.Search in first user dialog ──
  const userDialog = dialogs.find(
    (d) => d.entity?.className === "User" && !d.entity?.bot && !d.entity?.self
  );
  if (userDialog) {
    const entity = await client.getInputEntity(userDialog.entity.id);
    console.log(`\n${"═".repeat(80)}`);
    console.log(`🔍 messages.Search(peer=user:${userDialog.entity.id} "${userDialog.entity.firstName}", q="${q}", limit=5)`);
    console.log("═".repeat(80));
    try {
      const result = await client.invoke(
        new Api.messages.Search({
          peer: entity,
          q,
          filter: new Api.InputMessagesFilterEmpty(),
          minDate: 0,
          maxDate: 0,
          offsetId: 0,
          addOffset: 0,
          limit: 5,
          maxId: 0,
          minId: 0,
          hash: BigInt(0),
        })
      );
      console.log(JSON.stringify(dumpTlObject(result), null, 2));
    } catch (err) {
      console.error("messages.Search (user) error:", err.message);
    }
  }

  // ── 3. messages.Search with PhotoVideo filter ──
  if (userDialog) {
    const entity = await client.getInputEntity(userDialog.entity.id);
    console.log(`\n${"═".repeat(80)}`);
    console.log(`🔍 messages.Search(peer=user:${userDialog.entity.id}, filter=PhotoVideo, q="", limit=5)`);
    console.log("═".repeat(80));
    try {
      const result = await client.invoke(
        new Api.messages.Search({
          peer: entity,
          q: "",
          filter: new Api.InputMessagesFilterPhotoVideo(),
          minDate: 0,
          maxDate: 0,
          offsetId: 0,
          addOffset: 0,
          limit: 5,
          maxId: 0,
          minId: 0,
          hash: BigInt(0),
        })
      );
      console.log(JSON.stringify(dumpTlObject(result), null, 2));
    } catch (err) {
      console.error("messages.Search (photo) error:", err.message);
    }
  }

  // ── 4. messages.searchGlobal ──
  console.log(`\n${"═".repeat(80)}`);
  console.log(`🔍 messages.SearchGlobal(q="${q}", limit=5)`);
  console.log("═".repeat(80));
  try {
    const result = await client.invoke(
      new Api.messages.SearchGlobal({
        q,
        filter: new Api.InputMessagesFilterEmpty(),
        minDate: 0,
        maxDate: 0,
        offsetRate: 0,
        offsetPeer: new Api.InputPeerEmpty(),
        offsetId: 0,
        limit: 5,
      })
    );
    console.log(JSON.stringify(dumpTlObject(result), null, 2));
  } catch (err) {
    console.error("messages.SearchGlobal error:", err.message);
  }

  // ── 5. messages.Search with empty query (count media) ──
  console.log(`\n${"═".repeat(80)}`);
  console.log(`🔍 messages.Search(peer=InputPeerSelf, filter=PhotoVideo, q="", limit=1) — count only`);
  console.log("═".repeat(80));
  try {
    const result = await client.invoke(
      new Api.messages.Search({
        peer: new Api.InputPeerSelf(),
        q: "",
        filter: new Api.InputMessagesFilterPhotoVideo(),
        minDate: 0,
        maxDate: 0,
        offsetId: 0,
        addOffset: 0,
        limit: 1,
        maxId: 0,
        minId: 0,
        hash: BigInt(0),
      })
    );
    console.log(JSON.stringify(dumpTlObject(result), null, 2));
  } catch (err) {
    console.error("messages.Search (count) error:", err.message);
  }

  client.destroy();
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
