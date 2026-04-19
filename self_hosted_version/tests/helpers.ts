/**
 * Test helpers: boots a real MTProto server, connects via GramJS client,
 * and provides utilities for comparing responses against official fixtures.
 *
 * Uses vitest as the test runner (already a devDependency).
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync } from 'fs';
import { resolve, join, basename } from 'path';
import { randomBytes } from 'crypto';

// ─── Fixture loading ────────────────────────────────────────────────

const FIXTURES_DIR = resolve(process.cwd(), 'captures', 'test-fixtures');

export type Fixture = {
  method: string;
  capturedAt?: string;
  request?: any;
  response?: any;
  error?: string;
};

const fixtureCache = new Map<string, Fixture>();

export function loadFixture(name: string): Fixture | undefined {
  if (fixtureCache.has(name)) return fixtureCache.get(name);

  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = join(FIXTURES_DIR, `${safeName}.json`);
  if (!existsSync(path)) return undefined;

  const data = JSON.parse(readFileSync(path, 'utf8'));
  fixtureCache.set(name, data);
  return data;
}

export function listFixtures(): string[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))
    .map(f => f.replace('.json', ''));
}

export function hasFixture(name: string): boolean {
  return loadFixture(name) !== undefined;
}

// ─── Response structure comparison ──────────────────────────────────

/**
 * Compare a response from our server against the official Telegram fixture.
 * We don't check exact values (IDs, dates differ) but verify:
 * - Same constructor ID / class name
 * - Same field names present
 * - Same nested structure (constructor IDs of nested objects)
 * - Arrays have elements of the same type
 */
export type StructureDiff = {
  path: string;
  type: 'missing_field' | 'extra_field' | 'type_mismatch' | 'constructor_mismatch' | 'array_type_mismatch';
  expected?: string;
  actual?: string;
};

export function compareStructure(
  official: any,
  ours: any,
  path = '',
  diffs: StructureDiff[] = [],
  opts: { ignoreExtra?: boolean; maxDepth?: number } = {},
): StructureDiff[] {
  const maxDepth = opts.maxDepth ?? 6;
  if (path.split('.').length > maxDepth) return diffs;

  if (official === null || official === undefined) return diffs;
  if (ours === null || ours === undefined) {
    // Official has a value, we don't
    if (official !== null && official !== undefined) {
      diffs.push({ path, type: 'missing_field', expected: typeof official });
    }
    return diffs;
  }

  // Both are arrays
  if (Array.isArray(official) && Array.isArray(ours)) {
    // Check first element type matches
    if (official.length > 0 && ours.length > 0) {
      compareStructure(official[0], ours[0], `${path}[0]`, diffs, opts);
    }
    return diffs;
  }

  // Type mismatch
  if (typeof official !== typeof ours) {
    // Allow string↔number conversions (BigInt serialized as string)
    if ((typeof official === 'string' && typeof ours === 'number') ||
        (typeof official === 'number' && typeof ours === 'string')) {
      return diffs;
    }
    diffs.push({
      path,
      type: 'type_mismatch',
      expected: typeof official,
      actual: typeof ours,
    });
    return diffs;
  }

  // Both are objects
  if (typeof official === 'object' && official !== null) {
    // Check constructor ID match
    const officialCtor = official.__constructorId || official.__className;
    const oursCtor = ours.__constructorId || ours.__className;
    if (officialCtor && oursCtor && officialCtor !== oursCtor) {
      diffs.push({
        path,
        type: 'constructor_mismatch',
        expected: String(officialCtor),
        actual: String(oursCtor),
      });
    }

    // Check required fields exist in ours
    for (const key of Object.keys(official)) {
      if (key.startsWith('__') || key === 'originalArgs' || key === 'className' || key === 'classType' || key === 'SUBCLASS_OF_ID') continue;
      if (!(key in ours)) {
        diffs.push({
          path: path ? `${path}.${key}` : key,
          type: 'missing_field',
          expected: typeof official[key],
        });
      } else {
        compareStructure(official[key], ours[key], path ? `${path}.${key}` : key, diffs, opts);
      }
    }

    // Check for unexpected extra fields
    if (!opts.ignoreExtra) {
      for (const key of Object.keys(ours)) {
        if (key.startsWith('__') || key === 'originalArgs' || key === 'className' || key === 'classType' || key === 'SUBCLASS_OF_ID') continue;
        if (!(key in official)) {
          diffs.push({
            path: path ? `${path}.${key}` : key,
            type: 'extra_field',
            actual: typeof ours[key],
          });
        }
      }
    }
  }

  return diffs;
}

/**
 * Extract only the structure-significant fields from a fixture response
 * (constructorIds, field names, nested types). Strips values.
 */
export function extractShape(obj: any, depth = 0): any {
  if (depth > 8) return '[deep]';
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== 'object') return typeof obj;
  if (Array.isArray(obj)) {
    return obj.length > 0 ? [extractShape(obj[0], depth + 1)] : [];
  }

  const result: Record<string, any> = {};
  if (obj.__className) result.__className = obj.__className;
  if (obj.__constructorId) result.__constructorId = obj.__constructorId;

  for (const key of Object.keys(obj)) {
    if (key.startsWith('__') || key === 'originalArgs' || key === 'className' || key === 'classType' || key === 'SUBCLASS_OF_ID') continue;
    result[key] = extractShape(obj[key], depth + 1);
  }
  return result;
}

// ─── TL binary reader for parsing server responses ──────────────────

export class TlReader {
  private buf: Buffer;
  public offset: number;

  constructor(data: Buffer) {
    this.buf = data;
    this.offset = 0;
  }

  readInt(): number {
    const v = this.buf.readInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  readUInt(): number {
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  readLong(): bigint {
    const v = this.buf.readBigInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  readString(): string {
    let len = this.buf[this.offset++];
    let padding: number;
    if (len === 254) {
      len = this.buf[this.offset] | (this.buf[this.offset + 1] << 8) | (this.buf[this.offset + 2] << 16);
      this.offset += 3;
      padding = (4 - ((len + 4) % 4)) % 4;
    } else {
      padding = (4 - ((len + 1) % 4)) % 4;
    }
    const str = this.buf.slice(this.offset, this.offset + len).toString('utf8');
    this.offset += len + padding;
    return str;
  }

  readBool(): boolean {
    const v = this.readUInt();
    return v === 0x997275b5; // boolTrue
  }

  remaining(): number {
    return this.buf.length - this.offset;
  }

  peek(): number {
    return this.buf.readUInt32LE(this.offset);
  }

  raw(): Buffer {
    return this.buf;
  }
}

// ─── Temp DB helpers ────────────────────────────────────────────────

/**
 * Create a temp directory for test databases. 
 * Caller is responsible for cleanup.
 */
export function createTempDir(): string {
  const dir = resolve(process.cwd(), 'data', `.test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function cleanupTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}
