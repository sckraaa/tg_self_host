import { BinaryReader } from './codec.js';
import type { ClientSession } from './server.js';
import { setCurrentSession, currentSession } from './requestContext.js';
export { setCurrentSession as setActiveSession, currentSession as getActiveSession };
export declare const SEED_USER_ID = 100000;
export type ParsedHistoryRequest = {
    peerKey: string;
    offsetId: number;
    limit: number;
};
export type ParsedSendMessageRequest = {
    peerKey: string;
    message: string;
    randomId: string;
    replyToMsgId?: number;
    quoteText?: string;
    quoteOffset?: number;
    entities?: ParsedMessageEntity[];
};
/**
 * TL MessageEntity variants stored in a normalized shape (audit #2).
 * `type` mirrors the TL constructor and serialization is lossy only for the
 * variants we do not yet implement on the client side.
 */
export type ParsedMessageEntity = {
    type: 'unknown' | 'mention' | 'hashtag' | 'botCommand' | 'url' | 'email' | 'bold' | 'italic' | 'code' | 'pre' | 'textUrl' | 'mentionName' | 'phone' | 'cashtag' | 'underline' | 'strike' | 'blockquote' | 'bankCard' | 'spoiler' | 'customEmoji';
    offset: number;
    length: number;
    url?: string;
    userId?: number;
    language?: string;
    documentId?: string;
    collapsed?: boolean;
};
export type ParsedSendMediaRequest = {
    peerKey: string;
    message: string;
    randomId: string;
    replyToMsgId?: number;
    quoteText?: string;
    quoteOffset?: number;
    mediaType: 'photo' | 'document';
    fileId: string;
    mimeType?: string;
    fileName?: string;
    entities?: ParsedMessageEntity[];
    docAttributes?: Array<{
        type: 'imageSize';
        w: number;
        h: number;
    } | {
        type: 'filename';
        name: string;
    } | {
        type: 'audio';
        voice: boolean;
        duration: number;
        title?: string;
        performer?: string;
        waveform?: Buffer;
    }>;
};
export type ParsedReadHistoryRequest = {
    peerKey: string;
    maxId: number;
};
export type ParsedUpdatesDifferenceRequest = {
    pts: number;
};
export type ParsedChannelRef = {
    channelId: string;
};
export type ParsedUserRef = {
    userId: string;
};
export type ParsedPeerRef = {
    peerKey: string;
};
export interface ParsedSetTypingRequest {
    peerKey: string;
    actionConstructor: number;
}
export interface ParsedEditMessageRequest {
    peerKey: string;
    messageId: number;
    newText?: string;
    entities?: ParsedMessageEntity[];
}
export interface ParsedDeleteMessagesRequest {
    revoke: boolean;
    messageIds: number[];
}
export interface ParsedUploadProfilePhotoRequest {
    fileId?: string;
    targetUserId?: number;
}
/**
 * Resolve an InputPeer into a `<kind>:<id>` key.
 *
 * `session` is required to resolve `inputPeerSelf`. When the session is
 * unauthenticated (`session.userId` missing), `inputPeerSelf` returns
 * `undefined` instead of masquerading as the seed user — the caller should
 * surface that as `PEER_ID_INVALID` / `AUTH_KEY_UNREGISTERED` upstream.
 */
export declare function readInputPeerKey(reader: BinaryReader, session: ClientSession | undefined): string | undefined;
export declare function readInputDialogPeerKey(reader: BinaryReader, session: ClientSession | undefined): string | undefined;
export declare function readInputUserRef(reader: BinaryReader, session: ClientSession | undefined): ParsedUserRef | undefined;
export declare function parseHistoryRequest(data: Buffer, session: ClientSession | undefined): ParsedHistoryRequest | undefined;
export declare function parseGetMessagesRequest(data: Buffer): number[] | undefined;
export declare function parsePeerDialogsRequest(data: Buffer, session: ClientSession | undefined): string[];
export declare function parseSetTypingRequest(data: Buffer, session: ClientSession | undefined): ParsedSetTypingRequest | undefined;
export declare function parseEditMessageRequest(data: Buffer, session: ClientSession | undefined): ParsedEditMessageRequest | undefined;
export declare function parseDeleteMessagesRequest(data: Buffer): ParsedDeleteMessagesRequest | undefined;
export declare function parseReadHistoryRequest(data: Buffer, session: ClientSession | undefined): ParsedReadHistoryRequest | undefined;
export declare function parseUpdatesDifferenceRequest(data: Buffer): ParsedUpdatesDifferenceRequest | undefined;
export declare function parseChannelReadHistoryRequest(data: Buffer): ParsedReadHistoryRequest | undefined;
export declare function parseGetFullChannelRequest(data: Buffer): ParsedChannelRef | undefined;
export declare function parseGetFullUserRequest(data: Buffer, session?: ClientSession): ParsedUserRef | undefined;
export declare function parseGetUsersRequest(data: Buffer, session?: ClientSession): ParsedUserRef[] | undefined;
export declare function parsePeerVectorRequest(data: Buffer, session: ClientSession | undefined): ParsedPeerRef[] | undefined;
export declare function parseSendMessageRequest(data: Buffer, session: ClientSession | undefined): ParsedSendMessageRequest | undefined;
/**
 * Read a `Vector<MessageEntity>` from the TL stream (audit #2).
 *
 * Unknown entity constructors are skipped as best-effort: TL doesn't give us
 * an object length, so we advance the offset to end of buffer only if we
 * cannot identify the constructor. This is good enough for the web client which
 * only sends a small well-known subset.
 */
export declare function readMessageEntitiesVector(reader: BinaryReader): ParsedMessageEntity[];
/**
 * Augment entities with server-side auto-detected URLs / emails (audit follow-up).
 *
 * Real Telegram auto-linkifies plain URLs/emails that don't already have an
 * entity covering them, so the client can render them as clickable. Without
 * this, messages like "see https://example.com" arrive as plain text because
 * the web client only emits `messageEntityTextUrl` for entries it formatted
 * itself (Ctrl+K), never `messageEntityUrl` for typed URLs.
 *
 * Offsets here are in UTF-16 code units to match the TL convention used by
 * MessageEntity — that matches JavaScript's native string indexing.
 */
export declare function autoDetectUrlEntities(text: string, existing: ParsedMessageEntity[] | undefined): ParsedMessageEntity[] | undefined;
export declare function parseSendMediaRequest(data: Buffer, session: ClientSession | undefined): ParsedSendMediaRequest | undefined;
export declare function parseForwardMessagesRequest(data: Buffer, session: ClientSession): {
    fromPeerKey: string | undefined;
    toPeerKey: string | undefined;
    messageIds: number[];
    randomIds: string[];
    dropAuthor: boolean;
    dropMediaCaptions: boolean;
} | undefined;
export interface ParsedSearchRequest {
    peerKey?: string;
    query: string;
    filterType: 'empty' | 'photos' | 'video' | 'photo_video' | 'document' | 'url' | 'gif' | 'voice' | 'music' | 'pinned' | 'chat_photos' | 'other';
    minDate: number;
    maxDate: number;
    offsetId: number;
    addOffset: number;
    limit: number;
    maxId: number;
    minId: number;
}
export declare function parseSearchRequest(data: Buffer, session: ClientSession | undefined): ParsedSearchRequest | undefined;
export interface ParsedSearchGlobalRequest {
    query: string;
    filterType: ParsedSearchRequest['filterType'];
    minDate: number;
    maxDate: number;
    offsetId: number;
    limit: number;
    broadcastsOnly: boolean;
    groupsOnly: boolean;
    usersOnly: boolean;
}
export declare function parseSearchGlobalRequest(data: Buffer): ParsedSearchGlobalRequest | undefined;
export interface ParsedCreateChatRequest {
    userIds: number[];
    userAccessHashes: bigint[];
    title: string;
}
export declare function parseCreateChatRequest(data: Buffer): ParsedCreateChatRequest | undefined;
export interface ParsedCreateChannelRequest {
    isBroadcast: boolean;
    isMegagroup: boolean;
    title: string;
    about: string;
}
export declare function parseCreateChannelRequest(data: Buffer): ParsedCreateChannelRequest | undefined;
export interface ParsedSaveDraftRequest {
    peerKey: string | undefined;
    message: string;
    replyToMsgId?: number;
}
export declare function parseSaveDraftRequest(data: Buffer, session: ClientSession | undefined): ParsedSaveDraftRequest | undefined;
export interface ParsedSendReactionRequest {
    peerKey: string | undefined;
    msgId: number;
    reactions: string[];
}
export declare function parseSendReactionRequest(data: Buffer, session: ClientSession | undefined): ParsedSendReactionRequest | undefined;
export declare function parseGetFullChatRequest(data: Buffer): {
    chatId: number;
} | undefined;
export interface ParsedGetParticipantsRequest {
    channelId: number;
    channelAccessHash: bigint;
    offset: number;
    limit: number;
}
export declare function parseGetParticipantsRequest(data: Buffer): ParsedGetParticipantsRequest | undefined;
export declare function parseGetParticipantRequest(data: Buffer, session: ClientSession | undefined): {
    channelId: number;
    participantPeerKey: string | undefined;
} | undefined;
export interface ParsedInviteToChannelRequest {
    channelId: number;
    channelAccessHash: bigint;
    userIds: number[];
}
export declare function parseInviteToChannelRequest(data: Buffer): ParsedInviteToChannelRequest | undefined;
export declare function parseEditPhotoRequest(data: Buffer): {
    channelId: number;
    channelAccessHash: bigint;
    fileId?: string;
} | undefined;
export declare function parseEditChatPhotoRequest(data: Buffer): {
    chatId: number;
    fileId?: string;
} | undefined;
export declare function parseUploadProfilePhotoRequest(data: Buffer, session: ClientSession | undefined): ParsedUploadProfilePhotoRequest | undefined;
//# sourceMappingURL=parsers.d.ts.map