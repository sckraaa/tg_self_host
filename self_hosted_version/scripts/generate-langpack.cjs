#!/usr/bin/env node
// Parses langpack .strings / .xml exports from Telegram and generates JSON langpacks for the server.
// Source files: data/langpacks/{weba,android,ios,tdesktop,macos}.strings
// Output files: data/langpack-{pack}.json

const fs = require('fs');
const path = require('path');

const LANGPACKS_DIR = path.resolve(__dirname, '../data/langpacks');
const DATA_DIR = path.resolve(__dirname, '../data');

const PACKS = ['weba', 'android', 'ios', 'tdesktop', 'macos'];

function parseDotStrings(content) {
  // Format: "Key" = "Value";
  // Handle CRLF and CR line endings
  const strings = {};
  for (const line of content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    const match = line.match(/^"([^"]+)"\s*=\s*"(.*)";$/);
    if (match) {
      strings[match[1]] = match[2];
    }
  }
  return strings;
}

function parseAndroidXml(content) {
  // Format: <string name="Key">Value</string>
  const strings = {};
  const regex = /<string name="([^"]+)">([\s\S]*?)<\/string>/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    // Unescape XML entities
    let value = match[2]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/\\'/g, "'")
      .replace(/\\n/g, '\n');
    strings[match[1]] = value;
  }
  return strings;
}

fs.mkdirSync(DATA_DIR, { recursive: true });

let totalStrings = 0;

for (const pack of PACKS) {
  const inputPath = path.join(LANGPACKS_DIR, `${pack}.strings`);
  const outputPath = path.join(DATA_DIR, `langpack-${pack}.json`);

  if (!fs.existsSync(inputPath)) {
    console.warn(`[SKIP] ${inputPath} not found`);
    continue;
  }

  const content = fs.readFileSync(inputPath, 'utf8');

  let strings;
  if (content.trimStart().startsWith('<?xml') || content.trimStart().startsWith('<resources')) {
    strings = parseAndroidXml(content);
  } else {
    strings = parseDotStrings(content);
  }

  const count = Object.keys(strings).length;
  totalStrings += count;
  fs.writeFileSync(outputPath, JSON.stringify(strings, null, 2), 'utf8');
  console.log(`[${pack}] ${count} strings → ${outputPath}`);
}

// Also generate combined langpack-en.json (weba) for backward compatibility
const webaPath = path.join(DATA_DIR, 'langpack-weba.json');
if (fs.existsSync(webaPath)) {
  fs.copyFileSync(webaPath, path.join(DATA_DIR, 'langpack-en.json'));
  console.log(`\nCopied langpack-weba.json → langpack-en.json`);
}

console.log(`\nTotal: ${totalStrings} strings across ${PACKS.length} packs`);
