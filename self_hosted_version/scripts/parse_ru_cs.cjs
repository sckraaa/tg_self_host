const fs = require('fs');

function parseDotStrings(content) {
  const strings = {};
  for (const line of content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    const match = line.match(/^"([^"]+)"\s*=\s*"(.*)";$/);
    if (match) {
      strings[match[1]] = match[2];
    }
  }
  return strings;
}

const ru = fs.readFileSync('data/langpacks/weba_ru.strings', 'utf8');
const cs = fs.readFileSync('data/langpacks/weba_cs.strings', 'utf8');

fs.writeFileSync('data/langpack-ru.json', JSON.stringify(parseDotStrings(ru), null, 2));
fs.writeFileSync('data/langpack-cs.json', JSON.stringify(parseDotStrings(cs), null, 2));

console.log('Done!');
