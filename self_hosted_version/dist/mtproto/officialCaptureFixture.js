import { existsSync, readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
let cachedFixture;
export function getOfficialCaptureFixture(seedUserId) {
    if (cachedFixture !== undefined) {
        return cachedFixture || undefined;
    }
    const sourcePath = resolveFixturePath();
    if (!sourcePath) {
        cachedFixture = null;
        return undefined;
    }
    const run = JSON.parse(readFileSync(sourcePath, 'utf8'));
    const fixture = buildFixtureFromRun(run, sourcePath, String(seedUserId));
    cachedFixture = fixture || null;
    return fixture || undefined;
}
function resolveFixturePath() {
    const explicit = process.env.TELEGRAM_CAPTURE_RUN_PATH;
    if (explicit && existsSync(resolve(explicit))) {
        return resolve(explicit);
    }
    const candidateDirs = [
        resolve(process.cwd(), 'captures', 'official'),
        resolve(process.cwd(), 'self_hosted_version', 'captures', 'official'),
    ];
    for (const dir of candidateDirs) {
        if (!existsSync(dir)) {
            continue;
        }
        const latest = readdirSync(dir)
            .filter((fileName) => /^run-\d+\.json$/.test(fileName))
            .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
            .at(-1);
        if (latest) {
            return resolve(dir, latest);
        }
    }
    return undefined;
}
function buildFixtureFromRun(run, sourcePath, seedUserId) {
    const dialogCapture = run.captures.find((capture) => capture.method === 'messages.getDialogs' && isObject(capture.response));
    if (!dialogCapture || !isObject(dialogCapture.response)) {
        return undefined;
    }
    const selfUserId = findSelfUserId(run);
    const usersById = {};
    const chatsById = {};
    for (const capture of run.captures) {
        if (!isObject(capture.response) || !Array.isArray(capture.response.users)) {
            // continue with chats below
        }
        else {
            for (const user of capture.response.users.filter(isObject)) {
                const mappedUser = extractUser(user, selfUserId, seedUserId);
                usersById[mappedUser.id] = {
                    ...usersById[mappedUser.id],
                    ...mappedUser,
                };
            }
        }
        if (!isObject(capture.response) || !Array.isArray(capture.response.chats)) {
            continue;
        }
        for (const chat of capture.response.chats.filter(isObject)) {
            const mappedChat = extractChat(chat);
            if (!mappedChat) {
                continue;
            }
            chatsById[mappedChat.id] = {
                ...chatsById[mappedChat.id],
                ...mappedChat,
            };
        }
    }
    const peerDialogsByKey = {};
    const historiesByKey = {};
    for (const capture of run.captures) {
        if (!capture.peerKey || !isObject(capture.response)) {
            continue;
        }
        if (capture.method === 'messages.getPeerDialogs') {
            if (!isSupportedPeerKey(capture.peerKey)) {
                continue;
            }
            const remappedPeerKey = remapPeerKey(capture.peerKey, selfUserId, seedUserId);
            peerDialogsByKey[remappedPeerKey] = {
                dialogs: extractDialogs(capture.response.dialogs, selfUserId, seedUserId),
                messages: extractMessages(capture.response.messages, selfUserId, seedUserId),
                userIds: extractUserIds(capture.response.users, selfUserId, seedUserId),
                chatIds: extractChatIds(capture.response.chats),
            };
        }
        if (capture.method === 'messages.getHistory') {
            if (!isSupportedPeerKey(capture.peerKey)) {
                continue;
            }
            const remappedPeerKey = remapPeerKey(capture.peerKey, selfUserId, seedUserId);
            historiesByKey[remappedPeerKey] = {
                responseClassName: typeof capture.response.className === 'string'
                    ? capture.response.className
                    : 'messages.MessagesSlice',
                count: typeof capture.response.count === 'number' ? capture.response.count : undefined,
                pts: typeof capture.response.pts === 'number' ? capture.response.pts : undefined,
                peerKey: remappedPeerKey,
                messages: extractMessages(capture.response.messages, selfUserId, seedUserId),
                userIds: extractUserIds(capture.response.users, selfUserId, seedUserId),
                chatIds: extractChatIds(capture.response.chats),
            };
        }
    }
    return {
        sourcePath,
        dialogsCount: typeof dialogCapture.response.count === 'number'
            ? dialogCapture.response.count
            : Array.isArray(dialogCapture.response.dialogs)
                ? dialogCapture.response.dialogs.length
                : 0,
        dialogs: extractDialogs(dialogCapture.response.dialogs, selfUserId, seedUserId),
        dialogMessages: extractMessages(dialogCapture.response.messages, selfUserId, seedUserId),
        dialogUserIds: extractUserIds(dialogCapture.response.users, selfUserId, seedUserId),
        dialogChatIds: extractChatIds(dialogCapture.response.chats),
        peerDialogsByKey,
        historiesByKey,
        usersById,
        chatsById,
    };
}
function findSelfUserId(run) {
    for (const capture of run.captures) {
        if (!isObject(capture.response) || !Array.isArray(capture.response.users)) {
            continue;
        }
        for (const user of capture.response.users.filter(isObject)) {
            if (user.self === true && user.id !== undefined) {
                return String(user.id);
            }
        }
    }
    return undefined;
}
function extractUser(user, selfUserId, seedUserId) {
    const rawId = user.id !== undefined ? String(user.id) : seedUserId;
    const id = rawId === selfUserId ? seedUserId : rawId;
    return {
        id,
        accessHash: typeof user.accessHash === 'string' ? user.accessHash : undefined,
        firstName: typeof user.firstName === 'string' ? user.firstName : undefined,
        username: typeof user.username === 'string' ? user.username : undefined,
        phone: typeof user.phone === 'string' ? user.phone : undefined,
        self: rawId === selfUserId ? true : user.self === true,
    };
}
function extractDialogs(value, selfUserId, seedUserId) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .filter(isObject)
        .map((dialog) => ({
        peerKey: remapPeerKey(normalizePeer(dialog.peer) || '', selfUserId, seedUserId),
        topMessage: typeof dialog.topMessage === 'number' ? dialog.topMessage : 0,
        readInboxMaxId: typeof dialog.readInboxMaxId === 'number' ? dialog.readInboxMaxId : 0,
        readOutboxMaxId: typeof dialog.readOutboxMaxId === 'number' ? dialog.readOutboxMaxId : 0,
        unreadCount: typeof dialog.unreadCount === 'number' ? dialog.unreadCount : 0,
        unreadMentionsCount: typeof dialog.unreadMentionsCount === 'number' ? dialog.unreadMentionsCount : 0,
        unreadReactionsCount: typeof dialog.unreadReactionsCount === 'number' ? dialog.unreadReactionsCount : 0,
        pts: typeof dialog.pts === 'number' ? dialog.pts : undefined,
        draftDate: isObject(dialog.draft) && typeof dialog.draft.date === 'number' ? dialog.draft.date : undefined,
    }))
        .filter((dialog) => isSupportedPeerKey(dialog.peerKey));
}
function extractMessages(value, selfUserId, seedUserId) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .filter(isObject)
        .filter((message) => message.className === 'Message')
        .map((message) => ({
        id: typeof message.id === 'number' ? message.id : 0,
        peerKey: remapPeerKey(normalizePeer(message.peerId) || '', selfUserId, seedUserId),
        date: typeof message.date === 'number' ? message.date : 0,
        text: typeof message.message === 'string' ? message.message : '',
        className: typeof message.className === 'string' ? message.className : 'Message',
        out: message.out === true,
        post: message.post === true,
        fromPeerKey: remapPeerKey(normalizePeer(message.fromId) || '', selfUserId, seedUserId),
    }))
        .filter((message) => message.id > 0 && isSupportedPeerKey(message.peerKey));
}
function extractUserIds(value, selfUserId, seedUserId) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .filter(isObject)
        .map((user) => {
        const rawId = user.id !== undefined ? String(user.id) : undefined;
        if (!rawId) {
            return undefined;
        }
        return rawId === selfUserId ? seedUserId : rawId;
    })
        .filter((userId) => Boolean(userId));
}
function extractChatIds(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .filter(isObject)
        .map((chat) => chat.id !== undefined ? String(chat.id) : undefined)
        .filter((chatId) => Boolean(chatId));
}
function extractChat(chat) {
    if (chat.className !== 'Channel' || chat.id === undefined || typeof chat.title !== 'string') {
        return undefined;
    }
    return {
        id: String(chat.id),
        peerKey: `channel:${String(chat.id)}`,
        className: 'Channel',
        accessHash: typeof chat.accessHash === 'string' ? chat.accessHash : undefined,
        title: chat.title,
        username: typeof chat.username === 'string' ? chat.username : undefined,
        date: typeof chat.date === 'number' ? chat.date : 0,
        creator: chat.creator === true,
        broadcast: chat.broadcast === true,
    };
}
function normalizePeer(value) {
    if (!isObject(value) || typeof value.className !== 'string') {
        return undefined;
    }
    if (value.className === 'PeerUser' && value.userId !== undefined) {
        return `user:${String(value.userId)}`;
    }
    if (value.className === 'PeerChat' && value.chatId !== undefined) {
        return `chat:${String(value.chatId)}`;
    }
    if (value.className === 'PeerChannel' && value.channelId !== undefined) {
        return `channel:${String(value.channelId)}`;
    }
    return undefined;
}
function remapPeerKey(peerKey, selfUserId, seedUserId) {
    if (!selfUserId || !peerKey.endsWith(`:${selfUserId}`)) {
        return peerKey;
    }
    return `${peerKey.split(':', 1)[0]}:${seedUserId}`;
}
function isSupportedPeerKey(peerKey) {
    return peerKey.startsWith('user:') || peerKey.startsWith('channel:');
}
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=officialCaptureFixture.js.map