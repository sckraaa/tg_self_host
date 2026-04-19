import { BinaryReader } from './codec.js';
import type { ClientSession } from './server.js';
export declare function setActiveSession(session: ClientSession | undefined): void;
export declare function getActiveSession(): ClientSession | undefined;
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
}
export interface ParsedDeleteMessagesRequest {
    revoke: boolean;
    messageIds: number[];
}
export interface ParsedUploadProfilePhotoRequest {
    fileId?: string;
    targetUserId?: number;
}
export declare function readInputPeerKey(reader: BinaryReader): string | undefined;
export declare function readInputDialogPeerKey(reader: BinaryReader): string | undefined;
export declare function readInputUserRef(reader: BinaryReader, session?: ClientSession): ParsedUserRef | undefined;
export declare function parseHistoryRequest(data: Buffer): ParsedHistoryRequest | undefined;
export declare function parseGetMessagesRequest(data: Buffer): number[] | undefined;
export declare function parsePeerDialogsRequest(data: Buffer): string[];
export declare function parseSetTypingRequest(data: Buffer): ParsedSetTypingRequest | undefined;
export declare function parseEditMessageRequest(data: Buffer): ParsedEditMessageRequest | undefined;
export declare function parseDeleteMessagesRequest(data: Buffer): ParsedDeleteMessagesRequest | undefined;
export declare function parseReadHistoryRequest(data: Buffer): ParsedReadHistoryRequest | undefined;
export declare function parseUpdatesDifferenceRequest(data: Buffer): ParsedUpdatesDifferenceRequest | undefined;
export declare function parseChannelReadHistoryRequest(data: Buffer): ParsedReadHistoryRequest | undefined;
export declare function parseGetFullChannelRequest(data: Buffer): ParsedChannelRef | undefined;
export declare function parseGetFullUserRequest(data: Buffer, session?: ClientSession): ParsedUserRef | undefined;
export declare function parseGetUsersRequest(data: Buffer, session?: ClientSession): ParsedUserRef[] | undefined;
export declare function parsePeerVectorRequest(data: Buffer): ParsedPeerRef[] | undefined;
export declare function parseSendMessageRequest(data: Buffer): ParsedSendMessageRequest | undefined;
export declare function parseSendMediaRequest(data: Buffer): ParsedSendMediaRequest | undefined;
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
export declare function parseSearchRequest(data: Buffer): ParsedSearchRequest | undefined;
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
export declare function parseSaveDraftRequest(data: Buffer): ParsedSaveDraftRequest | undefined;
export interface ParsedSendReactionRequest {
    peerKey: string | undefined;
    msgId: number;
    reactions: string[];
}
export declare function parseSendReactionRequest(data: Buffer): ParsedSendReactionRequest | undefined;
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
export declare function parseGetParticipantRequest(data: Buffer): {
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
export declare function parseUploadProfilePhotoRequest(data: Buffer): ParsedUploadProfilePhotoRequest | undefined;
//# sourceMappingURL=parsers.d.ts.map