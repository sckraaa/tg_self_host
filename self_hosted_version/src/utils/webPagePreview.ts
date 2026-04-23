/**
 * Lightweight OpenGraph fetcher for `messages.getWebPagePreview` (audit #3).
 *
 * We cannot perform network I/O synchronously inside the TL handler, so the
 * cache is pre-populated in the background: the first call for a given URL
 * returns a best-effort empty preview and schedules a fetch; subsequent calls
 * return the cached parsed OG metadata. Cache entries expire after 30 minutes.
 *
 * Supports HTTP/SOCKS5 proxy via PREVIEW_PROXY env var for geo-blocked sites.
 */

import https from 'https';
import http from 'http';
import { getMessageStore } from '../database/messageStore.js';

export interface OgPreview {
  url: string;
  siteName?: string;
  title?: string;
  description?: string;
  type?: string;
  imageUrl?: string;
  /** Media ID of the downloaded OG image, if available. */
  photoMediaId?: number;
  /** Unix seconds. */
  fetchedAt: number;
}

const CACHE_TTL_SEC = 30 * 60;
const MAX_BYTES = 512 * 1024; // Only read the first 512KB — plenty for <head>.
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_CACHE_SIZE = 500;
const MAX_REDIRECTS = 5;

const cache = new Map<string, OgPreview | 'pending'>();

/** Build a language-specific cache key. */
function cacheKey(url: string, lang: string): string {
  return `${url}\n${lang}`;
}

/** Map short lang_code (e.g. 'ru', 'en', 'de') to Accept-Language header value. */
function langToAcceptLanguage(lang: string): string {
  const l = lang.toLowerCase();
  if (l === 'en' || l === 'en-us') return 'en-US,en;q=0.9';
  return `${l},en-US;q=0.5,en;q=0.3`;
}

export function extractFirstUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s<>"'`]+/i);
  return match?.[0];
}

export function getCachedPreview(url: string, lang = 'en'): OgPreview | undefined {
  const entry = cache.get(cacheKey(url, lang));
  if (!entry || entry === 'pending') return undefined;
  if (Date.now() / 1000 - entry.fetchedAt > CACHE_TTL_SEC) {
    cache.delete(cacheKey(url, lang));
    return undefined;
  }
  return entry;
}

/**
 * Try to find a cached preview for the URL in ANY language.
 * Used when serializing messages from history where no session lang is available.
 */
export function getCachedPreviewAnyLang(url: string): OgPreview | undefined {
  for (const [key, entry] of cache.entries()) {
    if (!key.startsWith(url + '\n')) continue;
    if (entry === 'pending') continue;
    if (Date.now() / 1000 - entry.fetchedAt > CACHE_TTL_SEC) {
      cache.delete(key);
      continue;
    }
    return entry;
  }
  return undefined;
}

const inflight = new Map<string, Promise<OgPreview | null>>();

export function requestPreviewFetch(url: string, lang = 'en'): Promise<OgPreview | null> {
  const cached = getCachedPreview(url, lang);
  if (cached) return Promise.resolve(cached);
  const key = cacheKey(url, lang);
  const existing = inflight.get(key);
  if (existing) return existing;

  if (cache.size > MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    if (typeof firstKey === 'string') cache.delete(firstKey);
  }
  cache.set(key, 'pending');
  const p = fetchOpenGraph(url, lang)
    .then((preview): OgPreview => {
      const full: OgPreview = { ...preview, fetchedAt: Math.floor(Date.now() / 1000) };
      cache.set(key, full);
      // Fire-and-forget: download og:image in background and update cache entry
      if (full.imageUrl) {
        downloadOgImage(full.imageUrl).then((mediaId) => {
          if (mediaId) {
            full.photoMediaId = mediaId;
            cache.set(key, full);
          }
        }).catch(() => { /* ignore image download failures */ });
      }
      return full;
    })
    .catch((err): null => {
      console.log(`[webPagePreview] fetch failed for ${url}:`, err?.message || err);
      cache.delete(key);
      return null;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

async function fetchOpenGraph(url: string, lang = 'en'): Promise<Omit<OgPreview, 'fetchedAt'>> {
  const html = await fetchHtml(url, MAX_REDIRECTS, lang);
  return { url, ...parseOpenGraph(html) };
}

/**
 * Download an OG image and store it as a media entry in the database.
 * Returns the mediaId or undefined on failure.
 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB max for OG images

async function downloadOgImage(imageUrl: string): Promise<number | undefined> {
  try {
    const data = await fetchBinary(imageUrl);
    if (!data || data.length === 0) return undefined;
    // Determine mime type from URL or default
    const ext = imageUrl.split('?')[0].split('.').pop()?.toLowerCase() || '';
    const mimeMap: Record<string, string> = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    };
    const mimeType = mimeMap[ext] || 'image/jpeg';
    const store = getMessageStore();
    const media = store.saveMedia({
      type: 'photo',
      fileData: data,
      mimeType,
    });
    console.log(`[webPagePreview] downloaded og:image (${data.length} bytes) => mediaId=${media.id}`);
    return media.id;
  } catch (err: any) {
    console.log(`[webPagePreview] og:image download failed for ${imageUrl}:`, err?.message || err);
    return undefined;
  }
}

function fetchBinary(url: string, redirectsLeft = MAX_REDIRECTS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { reject(new Error('Invalid URL')); return; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error('Unsupported protocol')); return;
    }
    if (isPrivateHost(parsed.hostname)) {
      reject(new Error('Private host')); return;
    }
    const agent = getProxyAgent(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'GET',
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'image/*,*/*;q=0.8',
      },
      timeout: REQUEST_TIMEOUT_MS,
      ...(agent ? { agent } : {}),
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
        const loc = Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location;
        res.resume();
        try {
          fetchBinary(new URL(loc, url).toString(), redirectsLeft - 1).then(resolve).catch(reject);
        } catch { reject(new Error('Bad redirect')); }
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume(); reject(new Error(`HTTP ${status}`)); return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_IMAGE_BYTES) { res.destroy(); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Timeout')); });
    req.end();
  });
}

// ========== HTTP fetcher ==========

/**
 * Try to load an HTTP(S) proxy agent if PREVIEW_PROXY is configured.
 * Supports http://, https://, socks5:// proxy URLs.
 * Falls back to direct connection if the proxy module isn't installed.
 */
function getProxyAgent(targetUrl: string): http.Agent | https.Agent | undefined {
  const proxyUrl = process.env.PREVIEW_PROXY;
  if (!proxyUrl) return undefined;

  try {
    // Try to use https-proxy-agent / http-proxy-agent / socks-proxy-agent
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { HttpsProxyAgent } = require('https-proxy-agent');
    return new HttpsProxyAgent(proxyUrl);
  } catch {
    // Module not installed, try node built-in (Node 20+ has undici-based fetch with proxy)
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { HttpProxyAgent } = require('http-proxy-agent');
      const parsed = new URL(targetUrl);
      if (parsed.protocol === 'http:') {
        return new HttpProxyAgent(proxyUrl);
      }
      return undefined;
    } catch {
      console.warn('[webPagePreview] PREVIEW_PROXY is set but proxy agent modules are not installed. Run: npm i https-proxy-agent');
      return undefined;
    }
  }
}

function fetchHtml(url: string, redirectsLeft = MAX_REDIRECTS, lang = 'en'): Promise<string> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch (e) { reject(new Error('Invalid URL')); return; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error('Unsupported protocol'));
      return;
    }
    // SSRF guard: refuse non-public hosts.
    if (isPrivateHost(parsed.hostname)) {
      reject(new Error('Refused to fetch private host'));
      return;
    }

    const agent = getProxyAgent(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'GET',
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'identity',
        'Accept-Language': langToAcceptLanguage(lang),
      },
      timeout: REQUEST_TIMEOUT_MS,
      ...(agent ? { agent } : {}),
    }, (res) => {
      const status = res.statusCode || 0;
      const locationHeader = res.headers.location;
      if ((status >= 300 && status < 400) && locationHeader && redirectsLeft > 0) {
        const loc = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
        let nextUrl: string;
        try {
          nextUrl = new URL(loc, url).toString();
        } catch {
          res.resume();
          reject(new Error(`Bad redirect URL: ${loc}`));
          return;
        }
        res.resume();
        fetchHtml(nextUrl, redirectsLeft - 1, lang).then(resolve).catch(reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      const contentType = String(res.headers['content-type'] || '');
      if (!/text\/html|application\/xhtml/i.test(contentType)) {
        res.resume();
        reject(new Error(`Not HTML: ${contentType}`));
        return;
      }

      // Detect charset from Content-Type header (e.g. "text/html; charset=windows-1251")
      const headerCharset = contentType.match(/charset\s*=\s*([^\s;]+)/i)?.[1]?.trim().toLowerCase();

      const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
      let stream: import('stream').Readable = res;
      if (encoding === 'gzip' || encoding === 'deflate' || encoding === 'br') {
        const zlib = require('zlib');
        if (encoding === 'br') {
          stream = res.pipe(zlib.createBrotliDecompress());
        } else {
          stream = res.pipe(zlib.createUnzip());
        }
      }

      const chunks: Buffer[] = [];
      let total = 0;
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BYTES) {
          stream.destroy();
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve(decodeBuffer(raw, headerCharset));
      });
      stream.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Timeout')); });
    req.end();
  });
}

/**
 * Decode a raw HTML buffer to a UTF-8 string, detecting charset from
 * the HTTP Content-Type header or HTML <meta> tags.
 */
function decodeBuffer(raw: Buffer, headerCharset?: string): string {
  // 1) Use HTTP header charset if specified and not utf-8
  const charset = normalizeCharset(headerCharset) || detectMetaCharset(raw) || 'utf-8';
  if (charset === 'utf-8') {
    return raw.toString('utf8');
  }
  // 2) Use TextDecoder for non-UTF-8 charsets (windows-1251, iso-8859-1, etc.)
  try {
    const decoder = new TextDecoder(charset);
    return decoder.decode(raw);
  } catch {
    // Unknown charset, fall back to UTF-8
    return raw.toString('utf8');
  }
}

function normalizeCharset(charset?: string): string | undefined {
  if (!charset) return undefined;
  const c = charset.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (c === 'utf8' || c === 'utf-8') return 'utf-8';
  return c || undefined;
}

/**
 * Sniff charset from HTML <meta> tags in the raw bytes.
 * Reads only ASCII-safe patterns so works even for non-UTF-8 documents.
 */
function detectMetaCharset(raw: Buffer): string | undefined {
  // Only scan the first 4KB for meta tags (they must appear in <head>)
  const probe = raw.subarray(0, 4096).toString('latin1');
  // <meta charset="...">
  const m1 = probe.match(/<meta\s+charset\s*=\s*["']?\s*([^\s"';>]+)/i);
  if (m1) return normalizeCharset(m1[1]);
  // <meta http-equiv="Content-Type" content="text/html; charset=...">
  const m2 = probe.match(/<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([^\s"';>]+)/i);
  if (m2) return normalizeCharset(m2[1]);
  return undefined;
}

function isPrivateHost(hostname: string): boolean {
  if (!hostname) return true;
  if (hostname === 'localhost' || hostname === '::1') return true;
  const m = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

// ========== HTML entity decoder ==========

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: '\u00A0', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»',
  bull: '•', middot: '·', prime: '′', Prime: '″',
  euro: '€', pound: '£', yen: '¥', cent: '¢',
  excl: '!',
};

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&(\w+);/g, (full, name) => NAMED_ENTITIES[name] ?? full);
}

// ========== OG parser ==========

function parseOpenGraph(html: string): Omit<OgPreview, 'url' | 'fetchedAt'> {
  const head = (html.match(/<head[^>]*>([\s\S]*?)<\/head>/i)?.[1]) || html.slice(0, 65536);
  const metaRe = /<meta\s+([^>]*?)\/?>/gi;
  const attrRe = /(\w[\w:-]*)\s*=\s*"([^"]*)"|(\w[\w:-]*)\s*=\s*'([^']*)'/g;
  const og: Record<string, string> = {};
  let m: RegExpExecArray | null;
  while ((m = metaRe.exec(head))) {
    const attrs: Record<string, string> = {};
    let a: RegExpExecArray | null;
    attrRe.lastIndex = 0;
    while ((a = attrRe.exec(m[1]))) {
      const name = (a[1] || a[3] || '').toLowerCase();
      const value = a[2] || a[4] || '';
      if (name) attrs[name] = value;
    }
    const key = (attrs['property'] || attrs['name'] || '').toLowerCase();
    const val = attrs['content'];
    if (key && val) og[key] = decodeHtmlEntities(val);
  }
  const titleTag = head.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
  const decodedTitle = titleTag ? decodeHtmlEntities(titleTag) : undefined;
  return {
    title: og['og:title'] || decodedTitle || og['twitter:title'] || undefined,
    description: og['og:description'] || og['description'] || og['twitter:description'] || undefined,
    siteName: og['og:site_name'] || undefined,
    type: og['og:type'] || undefined,
    imageUrl: og['og:image'] || og['twitter:image'] || undefined,
  };
}
