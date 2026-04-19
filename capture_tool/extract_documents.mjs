/**
 * Extract individual Document TL blobs from captured sticker set binaries.
 * Saves each document as data/documents/{docId}.bin for serving via getCustomEmojiDocuments.
 *
 * Uses GramJS's BinaryReader to parse the TL objects.
 *
 * Usage:
 *   node extract_documents.mjs
 */

import { BinaryReader } from "telegram/extensions/index.js";
import { Api } from "telegram";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { resolve, join } from "path";

const DATA_DIR = resolve(process.cwd(), "..", "self_hosted_version", "data");
const STICKER_SETS_DIR = join(DATA_DIR, "sticker_sets");
const DOCUMENTS_DIR = join(DATA_DIR, "documents");

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function main() {
  ensureDir(DOCUMENTS_DIR);

  const binFiles = readdirSync(STICKER_SETS_DIR).filter(f => f.endsWith(".bin"));
  console.log(`Found ${binFiles.length} sticker set binaries\n`);

  let totalDocs = 0;
  let newDocs = 0;
  let errors = 0;

  for (const binFile of binFiles) {
    const binPath = join(STICKER_SETS_DIR, binFile);
    const raw = readFileSync(binPath);

    try {
      const reader = new BinaryReader(Buffer.from(raw));
      const obj = reader.tgReadObject();

      // messages.stickerSet has .documents
      const documents = obj.documents || [];
      if (documents.length === 0) continue;

      let setNewDocs = 0;
      for (const doc of documents) {
        if (!doc || !doc.id) continue;
        const docId = doc.id.toString();
        const docPath = join(DOCUMENTS_DIR, `${docId}.bin`);

        if (existsSync(docPath)) {
          totalDocs++;
          continue;
        }

        try {
          const docBytes = doc.getBytes();
          writeFileSync(docPath, docBytes);
          totalDocs++;
          newDocs++;
          setNewDocs++;
        } catch (e) {
          errors++;
        }
      }

      if (setNewDocs > 0) {
        const setId = binFile.replace(".bin", "");
        process.stdout.write(`\r  ${setId}: ${documents.length} documents (${setNewDocs} new)`);
        process.stdout.write("\n");
      }
    } catch (e) {
      errors++;
      console.error(`  ❌ ${binFile}: ${e.message}`);
    }
  }

  console.log(`\n✅ Done! ${totalDocs} total documents, ${newDocs} newly extracted, ${errors} errors`);
}

main();
