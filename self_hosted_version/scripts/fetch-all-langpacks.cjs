const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.resolve(__dirname, '../data');
const PACKS = ['weba', 'android', 'ios', 'tdesktop', 'macos'];
const LANGS = ['ru', 'cs'];

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        return reject(new Error(`Failed to download ${url}: ${response.statusCode}`));
      }
      let content = '';
      response.on('data', (chunk) => { content += chunk; });
      response.on('end', () => resolve(content));
    }).on('error', reject);
  });
}

function parseDotStrings(content) {
  const strings = {};
  for (const line of content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    const match = line.match(/^"([^"]+)"\s*=\s*"(.*)";$/);
    if (match) strings[match[1]] = match[2];
  }
  return strings;
}

function parseAndroidXml(content) {
  const strings = {};
  const regex = /<string name="([^"]+)">([\s\S]*?)<\/string>/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
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

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  for (const lang of LANGS) {
    for (const pack of PACKS) {
      const url = `https://translations.telegram.org/${lang}/${pack}/export`;
      console.log(`Downloading ${url}...`);
      try {
        const content = await downloadFile(url);
        let strings;
        if (content.trimStart().startsWith('<?xml') || content.trimStart().startsWith('<resources')) {
          strings = parseAndroidXml(content);
        } else {
          strings = parseDotStrings(content);
        }
        
        const count = Object.keys(strings).length;
        const outputPath = path.join(DATA_DIR, `langpack-${pack}-${lang}.json`);
        fs.writeFileSync(outputPath, JSON.stringify(strings, null, 2), 'utf8');
        console.log(`[${pack}-${lang}] ${count} strings → ${outputPath}`);
      } catch (err) {
        console.error(`Error downloading ${pack}-${lang}: ${err.message}`);
      }
    }
  }
  console.log('Done!');
}

main();
