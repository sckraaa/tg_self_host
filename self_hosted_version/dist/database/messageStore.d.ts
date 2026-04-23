export interface StoredMessage {
    peerKey: string;
    messageId: number;
    clientRandomId?: string;
    date: number;
    text: string;
    isOutgoing: boolean;
    fromPeerKey?: string;
    post: boolean;
    editDate?: number;
    replyToMsgId?: number;
    quoteText?: string;
    quoteOffset?: number;
    mediaId?: number;
    fwdFromPeerKey?: string;
    fwdFromName?: string;
    fwdDate?: number;
    actionType?: string;
    /** Serialized TL `Vector<MessageEntity>` blob (audit #2). */
    entities?: Buffer;
}
export interface StoredChat {
    id: number;
    type: 'group' | 'supergroup' | 'channel';
    title: string;
    about: string;
    creatorUserId: number;
    accessHash: bigint;
    date: number;
    participantsCount: number;
    isBroadcast: boolean;
    isMegagroup: boolean;
    photoId?: number;
}
export interface StoredChatParticipant {
    chatId: number;
    userId: number;
    role: 'creator' | 'admin' | 'member';
    inviterId?: number;
    date: number;
    rank?: string;
}
export interface StoredReaction {
    ownerUserId: number;
    peerKey: string;
    messageId: number;
    userId: number;
    emoticon: string;
    date: number;
}
export interface StoredDraft {
    ownerUserId: number;
    peerKey: string;
    text: string;
    date: number;
    replyToMsgId?: number;
}
export interface StoredPeerState {
    peerKey: string;
    readInboxMaxId: number;
    readOutboxMaxId: number;
    readInboxTs: number;
}
export interface StoredUpdateState {
    pts: number;
    qts: number;
    date: number;
    seq: number;
    unreadCount: number;
}
export interface StoredUser {
    id: number;
    phone: string;
    firstName: string;
    lastName: string;
    username?: string;
    accessHash: bigint;
    createdAt: number;
    photoId?: number;
    about?: string;
    bot?: boolean;
    botInfoVersion?: number;
    botInlinePlaceholder?: string;
    botActiveUsers?: number;
    verified?: boolean;
    restricted?: boolean;
    scam?: boolean;
    fake?: boolean;
    premium?: boolean;
    langCode?: string;
    emojiStatusDocumentId?: string;
    emojiStatusUntil?: number;
    colorId?: number;
    colorBackgroundEmojiId?: string;
    profileColorId?: number;
    profileColorBackgroundEmojiId?: string;
    birthdayDay?: number;
    birthdayMonth?: number;
    birthdayYear?: number;
    commonChatsCount?: number;
    pinnedMsgId?: number;
    phoneCallsAvailable?: boolean;
    phoneCallsPrivate?: boolean;
    videoCallsAvailable?: boolean;
    voiceMessagesForbidden?: boolean;
    privateForwardName?: string;
    ttlPeriod?: number;
    themeEmoticon?: string;
    contactRequirePremium?: boolean;
    personalChannelId?: number;
    personalChannelMessage?: number;
    stargiftsCount?: number;
}
export interface StoredAuthCode {
    phone: string;
    code: string;
    phoneCodeHash: string;
    expiresAt: number;
}
export interface StoredMedia {
    id: number;
    type: 'photo' | 'document';
    filePath: string;
    mimeType: string;
    fileSize: number;
    width?: number;
    height?: number;
    fileName?: string;
    duration?: number;
    waveform?: Buffer;
    isVoice?: boolean;
    createdAt: number;
}
export interface StoredUpdateEvent {
    pts: number;
    ptsCount: number;
    date: number;
    kind: 'new_message' | 'read_history' | 'read_history_outbox' | 'edit_message' | 'delete_messages' | 'reaction';
    peerKey: string;
    messageId?: number;
    maxId?: number;
}
declare class MessageStore {
    private db;
    constructor(dbPath?: string);
    listMessages(ownerUserId: number, peerKey: string, limit?: number): StoredMessage[];
    findByRandomId(ownerUserId: number, peerKey: string, randomId: string): StoredMessage | undefined;
    listPeerKeys(ownerUserId: number): string[];
    getMessageForUser(messageId: number, userId: number): StoredMessage | undefined;
    getMessage(ownerUserId: number, peerKey: string, messageId: number): StoredMessage | undefined;
    getUnreadCount(ownerUserId: number, peerKey: string): number;
    getPeerState(ownerUserId: number, peerKey: string): StoredPeerState | undefined;
    getUpdateState(ownerUserId?: number): StoredUpdateState;
    listUpdateEventsAfter(ownerUserId: number, pts: number, limit?: number): StoredUpdateEvent[];
    markHistoryRead(ownerUserId: number, peerKey: string, maxId: number): {
        peerKey: string;
        readInboxMaxId: number;
        readOutboxMaxId: number;
        updatePts: number;
        updatePtsCount: number;
        updateDate: number;
    };
    appendUpdateEvent_ReadHistory(ownerUserId: number, peerKey: string, maxId: number): {
        pts: number;
        ptsCount: number;
    };
    appendUpdateEvent_ReadHistoryOutbox(ownerUserId: number, peerKey: string, maxId: number): {
        pts: number;
        ptsCount: number;
    };
    appendOutgoingMessage(ownerUserId: number, input: {
        peerKey: string;
        text: string;
        clientRandomId: string;
        seedMaxMessageId: number;
        fromPeerKey?: string;
        post?: boolean;
        replyToMsgId?: number;
        quoteText?: string;
        quoteOffset?: number;
        mediaId?: number;
        fwdFromPeerKey?: string;
        fwdFromName?: string;
        fwdDate?: number;
        actionType?: string;
        isIncoming?: boolean;
        entities?: Buffer;
    }): StoredMessage & {
        updatePts: number;
        updatePtsCount: number;
        updateDate: number;
    };
    markMessageIncoming(ownerUserId: number, peerKey: string, messageId: number): void;
    editMessage(ownerUserId: number, peerKey: string, messageId: number, newText: string, entities?: Buffer | null): {
        message: StoredMessage;
        updatePts: number;
        updatePtsCount: number;
    } | undefined;
    deleteMessages(ownerUserId: number, peerKey: string, messageIds: number[]): {
        updatePts: number;
        updatePtsCount: number;
    } | undefined;
    findMessageInAllPeers(ownerUserId: number, messageId: number): StoredMessage | undefined;
    /**
     * Resolve sender's messageIds to the corresponding messageIds in the recipient's store
     * for the **P2P** case (both stores share a single `recv_X <-> X` clientRandomId pair).
     *
     * Group/channel chats store one message per participant with distinct random ids
     * (`group_X_<uid>`, `group_fwd_X_<uid>`, …) and cannot be resolved by this simple
     * prefix trick — for those, look up by `peerKey` directly in each owner's store.
     * The preconditions below enforce that constraint so a misuse fails loudly instead
     * of silently returning empty or the wrong ids.
     */
    resolveRecipientMessageIds(senderUserId: number, senderPeerKey: string, recipientUserId: number, recipientPeerKey: string, senderMessageIds: number[]): number[];
    /**
     * Map a sender's message id in a group/channel to the recipient's own copy
     * (which was inserted during group broadcast with a `group_<senderRandom>_<uid>`
     * clientRandomId). This is the group-chat counterpart of
     * `resolveRecipientMessageIds` and is the key piece needed for reactions / edits
     * / deletes to span across participants' parallel copies.
     *
     * Falls back to a `(date, text)` lookup if the deterministic key isn't found —
     * useful during migrations from the old `group_fwd_<ts>_<i>_<uid>` scheme.
     */
    resolveGroupRecipientMessageIds(senderUserId: number, peerKey: string, senderMessageIds: number[], recipientUserId: number): number[];
    saveAuthKey(keyIdHex: string, authKey: Buffer): void;
    loadAllAuthKeys(): Array<{
        keyIdHex: string;
        authKey: Buffer;
        userId?: number;
    }>;
    bindAuthKeyToUser(keyIdHex: string, userId: number): void;
    getUserIdForAuthKey(keyIdHex: string): number | undefined;
    private getNextUserId;
    createUser(phone: string, firstName: string, lastName: string): StoredUser;
    private static readonly USER_COLUMNS;
    private mapUserRow;
    getUserByPhone(phone: string): StoredUser | undefined;
    getUserByUsername(username: string): StoredUser | undefined;
    getUserById(id: number): StoredUser | undefined;
    updateUser(id: number, fields: Partial<{
        firstName: string;
        lastName: string;
        username: string;
        photoId: number | null;
        about: string | null;
        bot: boolean;
        botInfoVersion: number | null;
        botInlinePlaceholder: string | null;
        botActiveUsers: number | null;
        verified: boolean;
        restricted: boolean;
        scam: boolean;
        fake: boolean;
        premium: boolean;
        langCode: string | null;
        emojiStatusDocumentId: string | null;
        emojiStatusUntil: number | null;
        colorId: number | null;
        colorBackgroundEmojiId: string | null;
        profileColorId: number | null;
        profileColorBackgroundEmojiId: string | null;
        birthdayDay: number | null;
        birthdayMonth: number | null;
        birthdayYear: number | null;
        commonChatsCount: number;
        pinnedMsgId: number | null;
        phoneCallsAvailable: boolean;
        phoneCallsPrivate: boolean;
        videoCallsAvailable: boolean;
        voiceMessagesForbidden: boolean;
        privateForwardName: string | null;
        ttlPeriod: number | null;
        themeEmoticon: string | null;
        contactRequirePremium: boolean;
        personalChannelId: number | null;
        personalChannelMessage: number | null;
        stargiftsCount: number | null;
    }>): void;
    searchUsers(query: string, excludeUserId?: number): StoredUser[];
    getAllUsers(excludeUserId?: number): StoredUser[];
    /** Get distinct peer keys that have stored messages for a user */
    getActivePeerKeys(ownerUserId: number): string[];
    /** Get last message for a peer key owned by a user */
    getLastMessage(ownerUserId: number, peerKey: string): StoredMessage | undefined;
    /** Get dialog peer keys for a user — simply all distinct peer_keys owned by this user */
    getDialogPeerKeysForUser(userId: number): string[];
    /** Alias for getLastMessage (owner scoping handles everything) */
    getLastMessageForUser(peerKey: string, userId: number): StoredMessage | undefined;
    /** Alias for listMessages (owner scoping handles everything) */
    listMessagesForUser(peerKey: string, userId: number, limit?: number): StoredMessage[];
    /** Full-text search using FTS5 index */
    searchMessages(ownerUserId: number, query: string, options?: {
        peerKey?: string;
        offsetId?: number;
        limit?: number;
        hasMedia?: boolean;
        peerPrefix?: string;
        actionType?: string;
    }): StoredMessage[];
    generateAuthCode(phone: string): StoredAuthCode;
    private fileParts;
    private assembledFiles;
    saveFilePart(fileId: string, partNum: number, data: Buffer): void;
    assembleFile(fileId: string): Buffer | undefined;
    getUploadedFile(fileId: string): Buffer | undefined;
    private getFilesDir;
    saveMedia(input: {
        type: 'photo' | 'document';
        fileData: Buffer;
        mimeType?: string;
        width?: number;
        height?: number;
        fileName?: string;
        duration?: number;
        waveform?: Buffer;
        isVoice?: boolean;
    }): StoredMedia;
    getMedia(mediaId: number): StoredMedia | undefined;
    getMediaFileData(mediaId: number): Buffer | undefined;
    verifyAuthCode(phone: string, phoneCodeHash: string, code: string): boolean;
    upsertSession(authKeyHex: string, userId: number | undefined, meta?: {
        deviceModel?: string;
        platform?: string;
        appVersion?: string;
    }): void;
    touchSession(authKeyHex: string): void;
    getSessionsForUser(userId: number): Array<{
        authKeyHex: string;
        deviceModel: string;
        platform: string;
        appVersion: string;
        createdAt: number;
        lastActivityAt: number;
    }>;
    deleteSession(authKeyHex: string): void;
    /** Delete sessions that haven't been active for the given TTL (seconds) */
    cleanupExpiredSessions(ttlSeconds: number): number;
    /** In-memory set of online user IDs (have active authenticated sessions) */
    private onlineUsers;
    /** In-memory map of userId -> was_online Unix timestamp */
    private userLastSeen;
    setUserOnline(userId: number): void;
    setUserOffline(userId: number): void;
    isUserOnline(userId: number): boolean;
    getUserLastSeen(userId: number): number | undefined;
    /** Get count of active sessions for a user from the clients map perspective */
    getOnlineUserIds(): number[];
    /**
     * Privacy rule types stored in DB:
     * 'allowAll', 'disallowAll', 'allowContacts', 'disallowContacts',
     * 'allowCloseFriends', 'allowPremium', 'allowBots', 'disallowBots',
     * 'allowUsers', 'disallowUsers', 'allowChatParticipants', 'disallowChatParticipants'
     */
    /** Get all privacy rules for a user+key */
    getPrivacyRules(userId: number, privacyKey: string): Array<{
        ruleType: string;
        value: number[];
    }>;
    /** Set privacy rules for a user+key (replaces all existing rules for that key) */
    setPrivacyRules(userId: number, privacyKey: string, rules: Array<{
        ruleType: string;
        value: number[];
    }>): void;
    /** Get a global privacy setting */
    getGlobalPrivacySetting(userId: number, key: string): string | undefined;
    /** Set a global privacy setting */
    setGlobalPrivacySetting(userId: number, key: string, value: string): void;
    /** Get all global privacy settings for a user */
    getAllGlobalPrivacySettings(userId: number): Record<string, string>;
    private getNextChatId;
    createChat(input: {
        type: 'group' | 'supergroup' | 'channel';
        title: string;
        about?: string;
        creatorUserId: number;
        isBroadcast?: boolean;
        isMegagroup?: boolean;
    }): StoredChat;
    getChatById(chatId: number): StoredChat | undefined;
    updateChat(chatId: number, fields: {
        title?: string;
        about?: string;
        photoId?: number;
    }): void;
    addChatParticipant(chatId: number, userId: number, role: 'creator' | 'admin' | 'member', inviterId?: number): void;
    removeChatParticipant(chatId: number, userId: number): void;
    getChatParticipants(chatId: number): StoredChatParticipant[];
    getChatParticipant(chatId: number, userId: number): StoredChatParticipant | undefined;
    setParticipantRole(chatId: number, userId: number, role: 'creator' | 'admin' | 'member', rank?: string): void;
    /** Get all chat IDs where a user is a participant */
    getChatsForUser(userId: number): number[];
    /** Delete a chat and all its participants, messages, drafts, and reactions */
    deleteChat(chatId: number, peerKey: string): void;
    saveDraft(ownerUserId: number, peerKey: string, text: string, replyToMsgId?: number): void;
    getDraft(ownerUserId: number, peerKey: string): StoredDraft | undefined;
    deleteDraft(ownerUserId: number, peerKey: string): void;
    getPinnedDialogs(ownerUserId: number): string[];
    isDialogPinned(ownerUserId: number, peerKey: string): boolean;
    setDialogPinned(ownerUserId: number, peerKey: string, pinned: boolean): void;
    reorderPinnedDialogs(ownerUserId: number, peerKeys: string[]): void;
    getNotifySettings(ownerUserId: number, peerKey: string): {
        muteUntil: number;
        showPreviews: boolean;
        silent: boolean;
    };
    setNotifySettings(ownerUserId: number, peerKey: string, input: {
        muteUntil?: number;
        showPreviews?: boolean;
        silent?: boolean;
    }): void;
    addContact(ownerUserId: number, contactUserId: number, firstName?: string, lastName?: string, phone?: string): void;
    deleteContact(ownerUserId: number, contactUserId: number): void;
    isContact(ownerUserId: number, contactUserId: number): boolean;
    listContacts(ownerUserId: number): Array<{
        contactUserId: number;
        firstName?: string;
        lastName?: string;
        phone?: string;
        date: number;
    }>;
    blockUser(ownerUserId: number, blockedUserId: number): void;
    unblockUser(ownerUserId: number, blockedUserId: number): void;
    isBlocked(ownerUserId: number, blockedUserId: number): boolean;
    listBlockedUsers(ownerUserId: number): Array<{
        userId: number;
        date: number;
    }>;
    setAdminRights(chatId: number, userId: number, flags: number, rank: string | undefined, promotedBy: number): void;
    setBannedRights(chatId: number, userId: number, flags: number, untilDate: number, kicked: boolean): void;
    updateChatTitle(chatId: number, title: string): void;
    updateChatAbout(chatId: number, about: string): void;
    getAllDrafts(ownerUserId: number): StoredDraft[];
    setReaction(ownerUserId: number, peerKey: string, messageId: number, userId: number, emoticon: string): void;
    removeReaction(ownerUserId: number, peerKey: string, messageId: number, userId: number): void;
    getReactions(ownerUserId: number, peerKey: string, messageId: number): StoredReaction[];
    appendReactionEvent(ownerUserId: number, peerKey: string, messageId: number): {
        pts: number;
        ptsCount: number;
    };
    private initSchema;
    private reconcileUpdateState;
    /**
     * Allocate a message_id that is unique within the owner's entire message set,
     * matching Telegram semantics (message_id is monotonic per user, not per peer).
     *
     * Per-peer counters were the source of cross-chat leaks in getDifference/getMessages/
     * forwardMessages lookups: two different chats of the same user could both contain
     * e.g. message_id=5, and any lookup that did not also scope by peer would pick the
     * wrong row.
     *
     * On first use for a user, the counter is seeded from MAX(message_id) of their
     * existing messages so that pre-existing data keeps working without renumbering.
     */
    private reserveMessageId;
    /**
     * Upsert peer state.
     *
     * `inboxTs` MUST only be provided by callers that are actually advancing
     * `readInboxMaxId` as a result of a real read action. Bookkeeping writes
     * (e.g. `appendOutgoingMessage`) must leave `inboxTs` undefined so we don't
     * synthesize a "read at now" timestamp for messages that were never read —
     * otherwise `getOutboxReadDate` / `getMessageReadParticipants` will report a
     * fake read time to the sender.
     */
    private upsertPeerState;
    private appendUpdateEvent;
}
export declare function getMessageStore(): MessageStore;
export {};
//# sourceMappingURL=messageStore.d.ts.map