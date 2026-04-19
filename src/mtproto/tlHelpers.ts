import { BinaryReader, BinaryWriter } from './codec.js';

// ========== TL String / Bytes write helpers ==========

export function writeTlString(w: BinaryWriter, str: string): void {
  const buf = Buffer.from(str, 'utf-8');
  let header: Buffer;
  let headerLen: number;
  if (buf.length <= 253) {
    header = Buffer.alloc(1);
    header[0] = buf.length;
    headerLen = 1;
  } else {
    header = Buffer.alloc(4);
    header[0] = 254;
    header[1] = buf.length & 0xff;
    header[2] = (buf.length >> 8) & 0xff;
    header[3] = (buf.length >> 16) & 0xff;
    headerLen = 4;
  }
  const totalLen = headerLen + buf.length;
  const padLen = (4 - (totalLen % 4)) % 4;
  w.writeBytes(Buffer.concat([header, buf, Buffer.alloc(padLen)]));
}

export function writeTlBytes(w: BinaryWriter, data: Buffer): void {
  let header: Buffer;
  let headerLen: number;
  if (data.length <= 253) {
    header = Buffer.alloc(1);
    header[0] = data.length;
    headerLen = 1;
  } else {
    header = Buffer.alloc(4);
    header[0] = 254;
    header[1] = data.length & 0xff;
    header[2] = (data.length >> 8) & 0xff;
    header[3] = (data.length >> 16) & 0xff;
    headerLen = 4;
  }
  const totalLen = headerLen + data.length;
  const padLen = (4 - (totalLen % 4)) % 4;
  w.writeBytes(Buffer.concat([header, data, Buffer.alloc(padLen)]));
}

// ========== TL String read helper ==========

export function readTlBytesRaw(reader: BinaryReader): Buffer {
  const first = reader.readByte();
  let length = first;

  if (first === 254) {
    const bytes = reader.readBytes(3);
    length = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16);
  }

  const value = reader.readBytes(length);
  const headerLength = first === 254 ? 4 : 1;
  const padding = (4 - ((headerLength + length) % 4)) % 4;
  if (padding > 0) {
    reader.readBytes(padding);
  }

  return Buffer.from(value);
}

export function readTlString(reader: BinaryReader): string {
  const first = reader.readByte();
  let length = first;

  if (first === 254) {
    const bytes = reader.readBytes(3);
    length = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16);
  }

  const value = reader.readBytes(length).toString('utf-8');
  const headerLength = first === 254 ? 4 : 1;
  const padding = (4 - ((headerLength + length) % 4)) % 4;
  if (padding > 0) {
    reader.readBytes(padding);
  }

  return value;
}

// ========== TL skip helpers (buffer offset based) ==========

export function skipTlString(data: Buffer, offset: number): number {
  const firstByte = data[offset];
  let len: number;
  let headerLen: number;
  
  if (firstByte <= 253) {
    len = firstByte;
    headerLen = 1;
  } else {
    len = data[offset + 1] | (data[offset + 2] << 8) | (data[offset + 3] << 16);
    headerLen = 4;
  }
  
  const totalOccupied = headerLen + len;
  const padding = totalOccupied % 4 === 0 ? 0 : 4 - (totalOccupied % 4);
  return offset + totalOccupied + padding;
}

export function skipJsonValue(data: Buffer, offset: number): number {
  const constructor = data.readUInt32LE(offset);
  offset += 4;
  
  switch (constructor) {
    case 0x99c1d49d: // jsonObject — value:Vector<JSONObjectValue>
    {
      // Vector prefix
      const vecConstructor = data.readUInt32LE(offset); offset += 4;
      const count = data.readInt32LE(offset); offset += 4;
      for (let i = 0; i < count; i++) {
        // jsonObjectValue#c0de1bd9 key:string value:JSONValue
        offset += 4; // skip jsonObjectValue constructor
        offset = skipTlString(data, offset); // key
        offset = skipJsonValue(data, offset); // value
      }
      return offset;
    }
    case 0xb71e767a: // jsonString — value:string
      return skipTlString(data, offset);
    case 0x2be0dfa4: // jsonNumber — value:double
      return offset + 8;
    case 0xf7444763: // jsonArray — value:Vector<JSONValue>
    {
      // Vector prefix
      const vecConstructor = data.readUInt32LE(offset); offset += 4;
      const count = data.readInt32LE(offset); offset += 4;
      for (let i = 0; i < count; i++) {
        offset = skipJsonValue(data, offset);
      }
      return offset;
    }
    case 0xc7345e6a: // jsonBool — value:Bool
      return offset + 4;
    case 0x3f6d7b68: // jsonNull
      return offset;
    default:
      console.warn(`[skipJsonValue] Unknown JSON constructor: 0x${constructor.toString(16)}`);
      return offset;
  }
}

// ========== TL skip helpers (BinaryReader based) ==========

export function skipTlStringByReader(reader: BinaryReader): void {
  const first = reader.readByte();
  let length = first;
  if (first === 254) {
    const bytes = reader.readBytes(3);
    length = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16);
  }
  reader.readBytes(length);
  const headerLength = first === 254 ? 4 : 1;
  const padding = (4 - ((headerLength + length) % 4)) % 4;
  if (padding > 0) reader.readBytes(padding);
}

export function skipInputPeer(reader: BinaryReader): void {
  const constructorId = reader.readInt() >>> 0;
  switch (constructorId) {
    case 0xdde8a54c: // inputPeerUser
      reader.readLong(); // user_id
      reader.readLong(); // access_hash
      break;
    case 0x35a95cb9: // inputPeerChat
      reader.readLong(); // chat_id
      break;
    case 0x27bcbbfc: // inputPeerChannel
      reader.readLong(); // channel_id
      reader.readLong(); // access_hash
      break;
    case 0x7da07ec9: // inputPeerSelf
    case 0x7f3b18ea: // inputPeerEmpty
      break;
    default:
      throw new Error(`Unknown InputPeer constructor: 0x${constructorId.toString(16)}`);
  }
}

export function parseInputReplyTo(reader: BinaryReader): { replyToMsgId: number; quoteText?: string; quoteOffset?: number } | undefined {
  const constructorId = reader.readInt() >>> 0;
  switch (constructorId) {
    case 0x869fbe10: { // inputReplyToMessage
      const flags = reader.readInt() >>> 0;
      const replyToMsgId = reader.readInt(); // reply_to_msg_id
      if (flags & (1 << 0)) reader.readInt(); // top_msg_id
      if (flags & (1 << 1)) skipInputPeer(reader); // reply_to_peer_id
      const quoteText = (flags & (1 << 2)) ? readTlString(reader) : undefined; // quote_text
      if (flags & (1 << 3)) skipTlVector(reader); // quote_entities
      const quoteOffset = (flags & (1 << 4)) ? reader.readInt() : undefined; // quote_offset
      if (flags & (1 << 5)) skipInputPeer(reader); // monoforum_peer_id
      if (flags & (1 << 6)) reader.readInt(); // todo_item_id
      return { replyToMsgId, quoteText, quoteOffset };
    }
    case 0x5881323a: { // inputReplyToStory
      skipInputPeer(reader); // peer
      reader.readInt(); // story_id
      return undefined;
    }
    case 0x69d66c45: { // inputReplyToMonoForum
      skipInputPeer(reader); // monoforum_peer_id
      return undefined;
    }
    default:
      return undefined;
  }
}

export function skipTlVector(reader: BinaryReader): void {
  // Generic vector skip - skips the vector constructor + count, then blindly skips items
  // This works by reading count and trying to skip each TL object
  const vectorConstructor = reader.readInt() >>> 0;
  if (vectorConstructor !== 0x1cb5c415) {
    throw new Error(`Expected vector constructor, got 0x${vectorConstructor.toString(16)}`);
  }
  const count = reader.readInt();
  for (let i = 0; i < count; i++) {
    skipTlObject(reader);
  }
}

export function skipTlObject(reader: BinaryReader): void {
  // Skip a single TL object by reading its constructor and known fixed fields
  // This is a best-effort approach for common types like MessageEntity
  const constructorId = reader.readInt() >>> 0;
  switch (constructorId) {
    // messageEntityBold, messageEntityItalic, messageEntityCode, etc.
    // All simple entities have: offset:int length:int
    case 0xbd610bc9: // messageEntityBold
    case 0x826f8b60: // messageEntityItalic
    case 0x28a20571: // messageEntityCode
    case 0x6cef8ac7: // messageEntityUnderline
    case 0xbf0693d4: // messageEntityStrike
    case 0x020df5d0: // messageEntityBlockquote
    case 0xbb92ba95: // messageEntityUnknown
    case 0xfa04579d: // messageEntityMention
    case 0x6f635b0d: // messageEntityHashtag
    case 0x6ed02538: // messageEntityBotCommand
    case 0x73924be0: // messageEntityUrl
    case 0x64e475c2: // messageEntityEmail
    case 0x4c4e743f: // messageEntityCashtag
    case 0x9b69e34b: // messageEntityPhone
    case 0x9c4e7e8b: // messageEntitySpoiler
      reader.readInt(); // offset
      reader.readInt(); // length
      break;
    case 0x76a6d327: // messageEntityTextUrl
      reader.readInt(); // offset
      reader.readInt(); // length
      skipTlStringByReader(reader); // url
      break;
    case 0xdc7b1140: // messageEntityMentionName
      reader.readInt(); // offset
      reader.readInt(); // length
      reader.readLong(); // user_id
      break;
    case 0x32ca960f: // messageEntityPre
      reader.readInt(); // offset
      reader.readInt(); // length
      skipTlStringByReader(reader); // language
      break;
    case 0xc8cf05f8: // messageEntityCustomEmoji
      reader.readInt(); // offset
      reader.readInt(); // length
      reader.readLong(); // document_id
      break;
    default:
      // Unknown entity type - try to skip offset(4) + length(4)
      reader.readInt();
      reader.readInt();
      break;
  }
}

// ========== Writer helpers ==========

export function writeEmptyVectorToWriter(w: BinaryWriter): void {
  w.writeInt(0x1cb5c415);
  w.writeInt(0);
}

export function writeBufferVector(w: BinaryWriter, items: Buffer[]): void {
  w.writeInt(0x1cb5c415);
  w.writeInt(items.length);
  for (const item of items) {
    w.writeBytes(item);
  }
}

export function writeIntVector(w: BinaryWriter, values: number[]): void {
  w.writeInt(0x1cb5c415);
  w.writeInt(values.length);
  for (const value of values) {
    w.writeInt(value);
  }
}

export function writeEmptyJsonObject(w: BinaryWriter): void {
  // jsonObject#99c1d49d value:Vector<JSONObjectValue>
  w.writeInt(0x99c1d49d);
  w.writeInt(0x1cb5c415);
  w.writeInt(0);
}

export interface InitConnectionInfo {
  deviceModel: string;
  systemVersion: string;
  appVersion: string;
  innerQuery: Buffer;
}

export function parseInitConnection(data: Buffer): InitConnectionInfo | null {
  try {
    const reader = new BinaryReader(data);
    reader.offset = 4; // skip constructor
    const flags = reader.readInt() >>> 0;
    reader.readInt(); // api_id
    const deviceModel = readTlString(reader);
    const systemVersion = readTlString(reader);
    const appVersion = readTlString(reader);
    // system_lang_code, lang_pack, lang_code
    readTlString(reader);
    readTlString(reader);
    readTlString(reader);
    // proxy (flags.0)
    if (flags & 1) {
      reader.readInt(); // constructor
      readTlString(reader); // address
      reader.readInt(); // port
    }
    // params (flags.1) - JSONValue — skip via offset advancement
    if (flags & 2) {
      const innerOffset = skipJsonValue(data, reader.offset);
      reader.offset = innerOffset;
    }
    return { deviceModel, systemVersion, appVersion, innerQuery: data.slice(reader.offset) };
  } catch {
    return null;
  }
}

export function skipInitConnection(data: Buffer): Buffer | null {
  // initConnection#c1cd5ea9 {X:Type} flags:# api_id:int device_model:string 
  // system_version:string app_version:string system_lang_code:string 
  // lang_pack:string lang_code:string proxy:flags.0?InputClientProxy params:flags.1?JSONValue query:!X
  try {
    let offset = 4; // skip constructor
    const flags = data.readUInt32LE(offset); offset += 4;
    offset += 4; // api_id
    
    // Skip TL strings: device_model, system_version, app_version, system_lang_code, lang_pack, lang_code
    for (let i = 0; i < 6; i++) {
      offset = skipTlString(data, offset);
    }
    
    // proxy (flags.0)
    if (flags & 1) {
      // InputClientProxy: constructor(4) + address(TL string) + port(4)
      offset += 4;
      offset = skipTlString(data, offset);
      offset += 4;
    }
    
    // params (flags.1) - JSONValue
    if (flags & 2) {
      offset = skipJsonValue(data, offset);
    }
    
    return data.slice(offset);
  } catch (e) {
    console.log(`[${new Date().toISOString()}] Failed to parse initConnection:`, (e as Error).message);
    return null;
  }
}
