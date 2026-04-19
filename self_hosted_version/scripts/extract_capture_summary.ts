import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type CaptureItem = {
  method: string;
  scope?: string;
  peerKey?: string;
  request: JsonValue;
  response: JsonValue;
};

type CaptureRun = {
  runId: number;
  createdAt: string;
  captures: CaptureItem[];
};

type FieldObservation = {
  kinds: string[];
  samples: string[];
  seenInMethods: string[];
};

type ClassObservation = {
  count: number;
  constructors: number[];
  seenInMethods: string[];
  fields: Record<string, FieldObservation>;
};

type DialogSnapshot = {
  sourceMethod: string;
  peerKey?: string;
  dialogPeerKey?: string;
  topMessage?: string;
  unreadCount?: number;
  unreadMentionsCount?: number;
  unreadReactionsCount?: number;
  readInboxMaxId?: string;
  readOutboxMaxId?: string;
  flags?: number;
  fieldNames: string[];
};

type MessageSnapshot = {
  sourceMethod: string;
  peerKey?: string;
  messageId?: string;
  peerId?: string;
  fromId?: string;
  date?: number;
  flags?: number;
  flags2?: number;
  textLength?: number;
  entityCount?: number;
  fieldNames: string[];
  className?: string;
};

type UserSnapshot = {
  sourceMethod: string;
  userId?: string;
  isSelf: boolean;
  hasAccessHash: boolean;
  hasPhone: boolean;
  hasUsername: boolean;
  hasPhoto: boolean;
  fieldNames: string[];
  className?: string;
};

type ChatSnapshot = {
  sourceMethod: string;
  chatId?: string;
  title?: string;
  fieldNames: string[];
  className?: string;
};

type FullUserSnapshot = {
  sourceMethod: string;
  userId?: string;
  fieldNames: string[];
  nestedClassName?: string;
};

const META_FIELDS = new Set([
  '__className',
  '__classType',
  '__constructorId',
  'CONSTRUCTOR_ID',
  'SUBCLASS_OF_ID',
  'className',
  'classType',
]);

function main() {
  const inputPath = resolveInputPath(process.argv.slice(2));
  const run = JSON.parse(readFileSync(inputPath, 'utf8')) as CaptureRun;

  const classCatalog: Record<string, ClassObservation> = {};
  const dialogs: DialogSnapshot[] = [];
  const messages: MessageSnapshot[] = [];
  const users = new Map<string, UserSnapshot>();
  const chats = new Map<string, ChatSnapshot>();
  const fullUsers: FullUserSnapshot[] = [];
  const methods = new Map<string, { count: number; responseClasses: Set<string> }>();

  for (const capture of run.captures) {
    const response = capture.response;
    const responseClass = getClassName(response);
    const methodEntry = methods.get(capture.method) || {
      count: 0,
      responseClasses: new Set<string>(),
    };
    methodEntry.count += 1;
    if (responseClass) {
      methodEntry.responseClasses.add(responseClass);
    }
    methods.set(capture.method, methodEntry);

    walkConstructors(response, capture.method, classCatalog);

    if (isObject(response) && Array.isArray(response.dialogs)) {
      dialogs.push(...response.dialogs
        .filter(isObject)
        .map((dialog) => extractDialogSnapshot(dialog, capture.method, capture.peerKey)));
    }

    if (isObject(response) && Array.isArray(response.messages)) {
      messages.push(...response.messages
        .filter(isObject)
        .map((message) => extractMessageSnapshot(message, capture.method, capture.peerKey)));
    }

    if (isObject(response) && Array.isArray(response.users)) {
      for (const user of response.users.filter(isObject)) {
        const snapshot = extractUserSnapshot(user, capture.method);
        if (!snapshot.userId) {
          continue;
        }

        const previous = users.get(snapshot.userId);
        users.set(snapshot.userId, mergeUserSnapshots(previous, snapshot));
      }
    }

    if (isObject(response) && Array.isArray(response.chats)) {
      for (const chat of response.chats.filter(isObject)) {
        const snapshot = extractChatSnapshot(chat, capture.method);
        if (!snapshot.chatId) {
          continue;
        }

        const previous = chats.get(snapshot.chatId);
        chats.set(snapshot.chatId, mergeChatSnapshots(previous, snapshot));
      }
    }

    if (capture.method === 'users.getFullUser' && isObject(response) && isObject(response.fullUser)) {
      fullUsers.push({
        sourceMethod: capture.method,
        userId: firstArrayObjectId(response.users),
        fieldNames: visibleFieldNames(response.fullUser),
        nestedClassName: getClassName(response.fullUser),
      });
    }
  }

  const summary = {
    sourceFile: inputPath,
    sourceBaseName: basename(inputPath),
    runId: run.runId,
    createdAt: run.createdAt,
    methods: Array.from(methods.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([method, entry]) => ({
        method,
        count: entry.count,
        responseClasses: Array.from(entry.responseClasses).sort(),
      })),
    entities: {
      dialogs,
      messages,
      users: Array.from(users.values()).sort((left, right) => (left.userId || '').localeCompare(right.userId || '')),
      chats: Array.from(chats.values()).sort((left, right) => (left.chatId || '').localeCompare(right.chatId || '')),
      fullUsers,
    },
    classCatalog: sortClassCatalog(classCatalog),
  };

  const outputPath = join(dirname(inputPath), `${basename(inputPath, '.json')}.summary.json`);
  writeFileSync(outputPath, JSON.stringify(summary, null, 2));

  // eslint-disable-next-line no-console
  console.log(`Wrote capture summary to ${outputPath}`);
}

function resolveInputPath(argv: string[]) {
  const inputFlagIndex = argv.indexOf('--input');
  if (inputFlagIndex >= 0 && argv[inputFlagIndex + 1]) {
    return resolve(argv[inputFlagIndex + 1]);
  }

  const capturesDir = resolve(process.cwd(), 'captures', 'official');
  const candidates = readdirSync(capturesDir)
    .filter((fileName) => /^run-\d+\.json$/.test(fileName))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  const latest = candidates.at(-1);
  if (!latest) {
    throw new Error(`No run-*.json files found in ${capturesDir}`);
  }

  return join(capturesDir, latest);
}

function walkConstructors(
  value: JsonValue,
  method: string,
  catalog: Record<string, ClassObservation>,
) {
  if (Array.isArray(value)) {
    for (const item of value) {
      walkConstructors(item, method, catalog);
    }
    return;
  }

  if (!isObject(value)) {
    return;
  }

  const className = getClassName(value);
  if (className) {
    const existing = catalog[className] || {
      count: 0,
      constructors: [],
      seenInMethods: [],
      fields: {},
    };

    existing.count += 1;
    const constructorId = getConstructorId(value);
    if (constructorId !== undefined && !existing.constructors.includes(constructorId)) {
      existing.constructors.push(constructorId);
    }
    if (!existing.seenInMethods.includes(method)) {
      existing.seenInMethods.push(method);
    }

    for (const [fieldName, fieldValue] of Object.entries(value)) {
      if (META_FIELDS.has(fieldName)) {
        continue;
      }

      const field = existing.fields[fieldName] || {
        kinds: [],
        samples: [],
        seenInMethods: [],
      };
      const kind = describeKind(fieldValue);
      if (!field.kinds.includes(kind)) {
        field.kinds.push(kind);
      }
      const sample = sampleValue(fieldValue);
      if (sample && !field.samples.includes(sample) && field.samples.length < 5) {
        field.samples.push(sample);
      }
      if (!field.seenInMethods.includes(method)) {
        field.seenInMethods.push(method);
      }
      existing.fields[fieldName] = field;
    }

    catalog[className] = existing;
  }

  for (const nestedValue of Object.values(value)) {
    walkConstructors(nestedValue, method, catalog);
  }
}

function extractDialogSnapshot(dialog: Record<string, JsonValue>, sourceMethod: string, peerKey?: string): DialogSnapshot {
  return {
    sourceMethod,
    peerKey,
    dialogPeerKey: normalizePeer(dialog.peer),
    topMessage: stringifyScalar(dialog.topMessage),
    unreadCount: numberOrUndefined(dialog.unreadCount),
    unreadMentionsCount: numberOrUndefined(dialog.unreadMentionsCount),
    unreadReactionsCount: numberOrUndefined(dialog.unreadReactionsCount),
    readInboxMaxId: stringifyScalar(dialog.readInboxMaxId),
    readOutboxMaxId: stringifyScalar(dialog.readOutboxMaxId),
    flags: numberOrUndefined(dialog.flags),
    fieldNames: visibleFieldNames(dialog),
  };
}

function extractMessageSnapshot(message: Record<string, JsonValue>, sourceMethod: string, peerKey?: string): MessageSnapshot {
  return {
    sourceMethod,
    peerKey,
    messageId: stringifyScalar(message.id),
    peerId: normalizePeer(message.peerId),
    fromId: normalizePeer(message.fromId),
    date: numberOrUndefined(message.date),
    flags: numberOrUndefined(message.flags),
    flags2: numberOrUndefined(message.flags2),
    textLength: typeof message.message === 'string' ? message.message.length : undefined,
    entityCount: Array.isArray(message.entities) ? message.entities.length : undefined,
    fieldNames: visibleFieldNames(message),
    className: getClassName(message),
  };
}

function extractUserSnapshot(user: Record<string, JsonValue>, sourceMethod: string): UserSnapshot {
  return {
    sourceMethod,
    userId: stringifyScalar(user.id),
    isSelf: Boolean(user.self),
    hasAccessHash: user.accessHash !== undefined && user.accessHash !== null,
    hasPhone: typeof user.phone === 'string' && user.phone.length > 0,
    hasUsername: typeof user.username === 'string' && user.username.length > 0,
    hasPhoto: isObject(user.photo),
    fieldNames: visibleFieldNames(user),
    className: getClassName(user),
  };
}

function mergeUserSnapshots(previous: UserSnapshot | undefined, next: UserSnapshot): UserSnapshot {
  if (!previous) {
    return next;
  }

  return {
    ...next,
    sourceMethod: `${previous.sourceMethod},${next.sourceMethod}`,
    isSelf: previous.isSelf || next.isSelf,
    hasAccessHash: previous.hasAccessHash || next.hasAccessHash,
    hasPhone: previous.hasPhone || next.hasPhone,
    hasUsername: previous.hasUsername || next.hasUsername,
    hasPhoto: previous.hasPhoto || next.hasPhoto,
    fieldNames: Array.from(new Set([...previous.fieldNames, ...next.fieldNames])).sort(),
  };
}

function extractChatSnapshot(chat: Record<string, JsonValue>, sourceMethod: string): ChatSnapshot {
  return {
    sourceMethod,
    chatId: stringifyScalar(chat.id),
    title: typeof chat.title === 'string' ? chat.title : undefined,
    fieldNames: visibleFieldNames(chat),
    className: getClassName(chat),
  };
}

function mergeChatSnapshots(previous: ChatSnapshot | undefined, next: ChatSnapshot): ChatSnapshot {
  if (!previous) {
    return next;
  }

  return {
    ...next,
    sourceMethod: `${previous.sourceMethod},${next.sourceMethod}`,
    title: previous.title || next.title,
    fieldNames: Array.from(new Set([...previous.fieldNames, ...next.fieldNames])).sort(),
  };
}

function visibleFieldNames(value: Record<string, JsonValue>) {
  return Object.keys(value)
    .filter((fieldName) => !META_FIELDS.has(fieldName))
    .sort();
}

function normalizePeer(value: JsonValue | undefined) {
  if (!isObject(value)) {
    return undefined;
  }

  const className = getClassName(value);
  if (className === 'PeerUser' && value.userId !== undefined) {
    return `user:${String(value.userId)}`;
  }
  if (className === 'PeerChat' && value.chatId !== undefined) {
    return `chat:${String(value.chatId)}`;
  }
  if (className === 'PeerChannel' && value.channelId !== undefined) {
    return `channel:${String(value.channelId)}`;
  }

  return className || undefined;
}

function firstArrayObjectId(value: JsonValue | undefined) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const first = value.find(isObject);
  if (!first) {
    return undefined;
  }

  return stringifyScalar(first.id);
}

function getClassName(value: JsonValue | undefined) {
  if (!isObject(value) || typeof value.className !== 'string') {
    return undefined;
  }

  return value.className;
}

function getConstructorId(value: JsonValue | undefined) {
  if (!isObject(value) || typeof value.CONSTRUCTOR_ID !== 'number') {
    return undefined;
  }

  return value.CONSTRUCTOR_ID;
}

function sortClassCatalog(catalog: Record<string, ClassObservation>) {
  return Object.fromEntries(
    Object.entries(catalog)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([className, observation]) => [
        className,
        {
          count: observation.count,
          constructors: observation.constructors.sort((left, right) => left - right),
          seenInMethods: observation.seenInMethods.sort(),
          fields: Object.fromEntries(
            Object.entries(observation.fields)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([fieldName, field]) => [
                fieldName,
                {
                  kinds: field.kinds.sort(),
                  samples: field.samples,
                  seenInMethods: field.seenInMethods.sort(),
                },
              ]),
          ),
        },
      ]),
  );
}

function describeKind(value: JsonValue) {
  if (Array.isArray(value)) {
    return value.length > 0 ? `array<${describeKind(value[0])}>` : 'array<empty>';
  }

  if (isObject(value)) {
    return getClassName(value) || 'object';
  }

  if (value === null) {
    return 'null';
  }

  return typeof value;
}

function sampleValue(value: JsonValue) {
  if (Array.isArray(value)) {
    return `len=${value.length}`;
  }

  if (isObject(value)) {
    return getClassName(value) || `keys=${Object.keys(value).slice(0, 5).join(',')}`;
  }

  if (typeof value === 'string') {
    return value.length > 40 ? `str:${value.slice(0, 40)}...` : `str:${value}`;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return undefined;
}

function stringifyScalar(value: JsonValue | undefined) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return undefined;
}

function numberOrUndefined(value: JsonValue | undefined) {
  return typeof value === 'number' ? value : undefined;
}

function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

main();
