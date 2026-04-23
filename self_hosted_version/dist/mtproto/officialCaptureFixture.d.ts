export interface FixtureUser {
    id: string;
    accessHash?: string;
    firstName?: string;
    lastName?: string;
    username?: string;
    phone?: string;
    photoId?: number;
    self?: boolean;
    contact?: boolean;
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
export interface FixtureDialog {
    peerKey: string;
    topMessage: number;
    readInboxMaxId: number;
    readOutboxMaxId: number;
    unreadCount: number;
    unreadMentionsCount: number;
    unreadReactionsCount: number;
    pts?: number;
    draftDate?: number;
}
export interface FixtureMessage {
    id: number;
    peerKey: string;
    date: number;
    text: string;
    className: string;
    out?: boolean;
    post?: boolean;
    fromPeerKey?: string;
    savedPeerKey?: string;
    editDate?: number;
    replyToMsgId?: number;
    quoteText?: string;
    quoteOffset?: number;
    mediaId?: number;
    fwdFromPeerKey?: string;
    fwdFromName?: string;
    fwdDate?: number;
    action?: {
        type: 'chatCreate' | 'channelCreate' | 'chatEditPhoto' | 'chatDeleteUser' | 'phoneCall';
        title: string;
        userIds?: number[];
        photoId?: number;
        userId?: number;
        callId?: string;
        duration?: number;
        reason?: string;
        isVideo?: boolean;
    };
    reactions?: Array<{
        emoticon: string;
        count: number;
        chosenOrder?: number;
    }>;
    /**
     * Serialized `Vector<MessageEntity>` buffer (audit #2). When set, it is written
     * verbatim into the TL stream with flag 7, preserving bold/italic/links/mentions.
     */
    entities?: Buffer;
}
export interface FixtureHistory {
    responseClassName: string;
    count?: number;
    pts?: number;
    peerKey: string;
    messages: FixtureMessage[];
    userIds: string[];
    chatIds: string[];
}
export interface FixtureChat {
    id: string;
    peerKey: string;
    className: 'Channel';
    accessHash?: string;
    title: string;
    username?: string;
    date: number;
    creator?: boolean;
    broadcast?: boolean;
}
export interface OfficialCaptureFixture {
    sourcePath: string;
    dialogsCount: number;
    dialogs: FixtureDialog[];
    dialogMessages: FixtureMessage[];
    dialogUserIds: string[];
    dialogChatIds: string[];
    peerDialogsByKey: Record<string, {
        dialogs: FixtureDialog[];
        messages: FixtureMessage[];
        userIds: string[];
        chatIds: string[];
    }>;
    historiesByKey: Record<string, FixtureHistory>;
    usersById: Record<string, FixtureUser>;
    chatsById: Record<string, FixtureChat>;
}
export declare function getOfficialCaptureFixture(seedUserId: number): OfficialCaptureFixture | undefined;
//# sourceMappingURL=officialCaptureFixture.d.ts.map