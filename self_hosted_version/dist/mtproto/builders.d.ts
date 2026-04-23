import { type StoredUser, type StoredChat, type StoredChatParticipant } from '../database/messageStore.js';
import type { FixtureMessage, OfficialCaptureFixture } from './officialCaptureFixture.js';
import type { ClientSession } from './server.js';
export declare function buildConfig(): Buffer;
export declare function buildAppConfig(): Buffer;
export declare function buildUpdatesState(selfId?: number): Buffer;
export declare function buildLangPackDifference(packName?: string): Buffer;
export declare function buildLangPackStringsResponse(packName: string, keys: string[]): Buffer;
export declare function buildLangPackLanguage(): Buffer;
export declare function buildEmptyVector(): Buffer;
export declare function buildUpdatesDifferenceEmpty(selfId: number): Buffer;
export declare function buildUpdatesDifference(data: Buffer, selfId: number): Buffer;
export declare function buildUpdateReadHistoryInbox(peerKey: string, maxId: number, pts: number, ptsCount: number, selfId?: number): Buffer;
export declare function buildUpdateReadHistoryOutbox(peerKey: string, maxId: number, pts: number, ptsCount: number): Buffer;
export declare function buildUpdateNewMessage(message: FixtureMessage, pts: number, ptsCount: number): Buffer;
export declare function buildUpdateEditMessage(message: FixtureMessage, pts: number, ptsCount: number): Buffer;
export declare function buildUpdateDeleteMessages(messageIds: number[], pts: number, ptsCount: number): Buffer;
export declare function buildUpdateMessageID(messageId: number, randomId: string): Buffer;
/**
 * updateDraftMessage#ee2bb969 flags:# peer:Peer top_msg_id:flags.0?int
 *   saved_peer_id:flags.1?Peer draft:DraftMessage
 * (audit #8 — live push to other sessions when a draft is saved)
 */
export declare function buildUpdateDraftMessage(peerKey: string, text: string, date: number, replyToMsgId?: number): Buffer;
export declare function buildUpdateUserStatus(userId: number, isOffline: boolean, statusVisible?: boolean): Buffer;
export declare function buildUpdateUserTyping(userId: number, actionConstructor: number): Buffer;
/**
 * Build a live envelope carrying `updateUser#20529438 user_id:long`, which tells
 * recipient clients to refetch this user (typically used after the user's photo
 * changes so other users see the new avatar without reloading the page).
 */
export declare function buildLiveUpdateUserEnvelope(userId: number): Buffer;
export declare function buildUpdateUserNameUpdate(userId: number, firstName: string, lastName: string, username: string | undefined): Buffer;
export declare function buildLiveUpdatesEnvelope(updateBuffers: Buffer[], userIds: string[], chatIds: string[]): Buffer;
export declare function buildLiveNewMessageUpdates(peerKey: string, messageId: number, pts: number, ptsCount: number): Buffer | null;
export declare function buildLiveReadHistoryUpdates(peerKey: string, maxId: number, pts: number, ptsCount: number, selfId?: number): Buffer;
export declare function buildUserFullForUser(session: ClientSession, fixture: OfficialCaptureFixture | undefined, userId: string): Buffer;
export declare function buildUsersVector(session: ClientSession): Buffer;
export declare function buildUsersVectorForIds(session: ClientSession, fixture: OfficialCaptureFixture | undefined, userIds: string[]): Buffer;
export declare function buildDialogFilters(): Buffer;
export declare function buildDialogsEmpty(): Buffer;
export declare function buildDialogsFromDb(selfId: number): Buffer;
export declare function buildPeerDialogsForPeers(peerKeys: string[], selfId: number): Buffer;
export declare function buildPinnedDialogs(selfId?: number): Buffer;
export declare function buildGetMessagesResponse(messages: FixtureMessage[], fixture?: OfficialCaptureFixture | null, selfId?: number): Buffer;
export declare function buildMessagesSliceEmpty(): Buffer;
export declare function buildMessagesEmpty(): Buffer;
export declare function buildWebPagePreviewEmpty(): Buffer;
/**
 * Build a `messages.WebPagePreview` wrapping a real `webPage#e89c45b2` parsed from
 * OpenGraph meta tags (audit #3). `photo` is not attached because we don't
 * download and persist remote images yet — if `imageUrl` is provided the client
 * can fetch it via the normal img pipeline using the URL in `site_name`/`description`.
 */
export declare function buildWebPagePreviewFromOg(opts: {
    url: string;
    siteName?: string;
    title?: string;
    description?: string;
    type?: string;
}): Buffer;
export declare function buildRecentStoriesVector(count: number): Buffer;
export declare function buildTermsOfServiceUpdateEmpty(): Buffer;
export declare function buildSentCode(phoneCodeHash: string, codeLength: number): Buffer;
export declare function buildAuthAuthorization(user: StoredUser): Buffer;
export declare function buildAuthSignUpRequired(): Buffer;
export declare function buildLoginToken(): Buffer;
export declare function buildContactsFromDb(selfId: number): Buffer;
export declare function buildContactsFound(query: string, selfId: number): Buffer;
export declare function buildResolvedPeer(username: string): Buffer;
export declare function buildResolvedPeerForUser(user: StoredUser): Buffer;
export declare function buildChannelFullEmpty(channelId?: string): Buffer;
export declare function buildBoolTrue(): Buffer;
export declare function buildBoolFalse(): Buffer;
export declare function buildNearestDc(): Buffer;
export declare function buildPeerNotifySettings(settings?: {
    showPreviews?: boolean;
    silent?: boolean;
    muteUntil?: number;
}): Buffer;
export declare function buildPeerColorsEmpty(): Buffer;
export declare function buildPeerProfileColors(): Buffer;
export declare function buildCountriesListEmpty(): Buffer;
export declare function buildPromoDataEmpty(): Buffer;
export declare function buildAuthorizationsEmpty(): Buffer;
export declare function buildAuthorizations(sessions: Array<{
    authKeyHex: string;
    deviceModel: string;
    platform: string;
    appVersion: string;
    createdAt: number;
    lastActivityAt: number;
}>, currentAuthKeyHex?: string): Buffer;
export declare function buildWallPapersNotModified(): Buffer;
export declare function buildStickerSetNotModified(): Buffer;
export declare function buildUpdateMessageReactions(peerKey: string, msgId: number, reactions: Array<{
    emoticon: string;
    count: number;
    chosenOrder?: number;
}>): Buffer;
export declare function buildLiveUpdateMessageReactions(peerKey: string, msgId: number, reactions: Array<{
    emoticon: string;
    count: number;
    chosenOrder?: number;
}>): Buffer;
export declare function buildUpdatesEmpty(): Buffer;
export declare function buildTopPeersDisabled(): Buffer;
export declare function buildBlockedEmpty(): Buffer;
/** contacts.blocked#ade1591 blocked:Vector<PeerBlocked> chats:Vector<Chat> users:Vector<User> (audit #6) */
export declare function buildBlockedFromDb(selfId: number): Buffer;
export declare function buildAvailableReactionsNotModified(): Buffer;
export declare function buildAvailableReactions(): Buffer;
export declare function buildEmojiStickers(): Buffer;
export declare function buildFeaturedEmojiStickers(): Buffer;
export declare function buildStickerSetFromCapture(setId: string): Buffer | undefined;
export declare function buildStickerSetFromCaptureByShortName(shortName: string): Buffer | undefined;
export declare function buildStickerSetFromCaptureByTypeName(typeName: string): Buffer | undefined;
export declare function buildSavedDialogsEmpty(): Buffer;
export declare function buildSponsoredMessagesEmpty(): Buffer;
export declare function buildSponsoredPeersEmpty(): Buffer;
export declare function buildSearchPostsFlood(): Buffer;
export declare function buildAllStoriesEmpty(): Buffer;
export declare function buildTopReactions(): Buffer;
export declare function buildRecentReactions(): Buffer;
export declare function buildReactionsEmpty(): Buffer;
export declare function buildGlobalPrivacySettings(): Buffer;
export declare function buildAttachMenuBotsNotModified(): Buffer;
export declare function buildEmojiKeywordsDifference(): Buffer;
export declare function buildEmojiURL(): Buffer;
export declare function buildReactionsNotModified(): Buffer;
export declare function buildDefaultHistoryTTL(): Buffer;
export declare function buildSavedReactionTagsEmpty(): Buffer;
export declare function buildQuickRepliesEmpty(): Buffer;
export declare function buildAvailableEffectsEmpty(): Buffer;
export declare function buildStarsStatusEmpty(): Buffer;
export declare function buildEmojiStatusesEmpty(): Buffer;
export declare function buildStarGiftsEmpty(): Buffer;
export declare function buildSavedStarGiftsEmpty(): Buffer;
export declare function buildStarGiftActiveAuctionsEmpty(): Buffer;
export declare function buildTimezonesListEmpty(): Buffer;
export declare function buildContentSettings(): Buffer;
export declare function buildPrivacyRulesEmpty(): Buffer;
/**
 * Build account.PrivacyRules#50a04e45 with actual rules from DB.
 * rules: PrivacyRule[], chats: Chat[], users: User[]
 */
export declare function buildPrivacyRules(rules: Array<{
    ruleType: string;
    value: number[];
}>): Buffer;
/**
 * Build globalPrivacySettings with actual stored settings.
 */
export declare function buildGlobalPrivacySettingsFromDb(settings: Record<string, string>): Buffer;
export declare function buildAccountPassword(): Buffer;
export declare function buildAllStickersNotModified(): Buffer;
export declare function buildAllStickersEmpty(): Buffer;
export declare function buildFeaturedStickersNotModified(): Buffer;
export declare function buildRecentStickersNotModified(): Buffer;
export declare function buildSavedGifsNotModified(): Buffer;
export declare function buildFavedStickersNotModified(): Buffer;
export declare function buildAffectedMessages(pts: number, ptsCount: number): Buffer;
/**
 * Build messages.invitedUsers#7f5defa6 response for messages.createChat
 * updates:Updates missing_invitees:Vector<MissingInvitee>
 *
 * Real Telegram sends 4 updates:
 * 1. UpdateMessageID — maps randomId to service message id
 * 2. UpdateChatParticipants — full participant list
 * 3. UpdateNewMessage — MessageService with MessageActionChatCreate
 * 4. UpdateReadHistoryOutbox — marks service msg as read
 */
export declare function buildInvitedUsers(chat: StoredChat, participants: StoredChatParticipant[], selfId: number, serviceMessage?: FixtureMessage, pts?: number, ptsCount?: number, randomId?: string): Buffer;
/**
 * Build updateChatParticipants#07761198 participants:ChatParticipants
 */
export declare function buildUpdateChatParticipants(chatId: number, participants: StoredChatParticipant[], selfId: number): Buffer;
/**
 * Build Updates response for channels.createChannel
 *
 * Real Telegram sends 4 updates:
 * 1. UpdateMessageID — maps randomId to service message id
 * 2. UpdateChannel — channel notification
 * 3. UpdateReadChannelInbox — marks service msg as read
 * 4. UpdateNewChannelMessage — MessageService with MessageActionChannelCreate
 */
export declare function buildCreateChannelUpdates(chat: StoredChat, selfId: number, serviceMessage?: FixtureMessage, pts?: number, ptsCount?: number, randomId?: string): Buffer;
/** updateChannel#635b4c09 channel_id:long */
export declare function buildUpdateChannel(channelId: number): Buffer;
/** updateReadChannelInbox#922e6e10 flags:# folder_id:flags.0?int channel_id:long max_id:int still_unread_count:int pts:int */
export declare function buildUpdateReadChannelInbox(channelId: number, maxId: number, pts: number): Buffer;
/** updateNewChannelMessage#62ba04d9 message:Message pts:int pts_count:int */
export declare function buildUpdateNewChannelMessage(message: FixtureMessage, pts: number, ptsCount: number): Buffer;
/**
 * Build messages.chatFull#e5d7d19c for messages.getFullChat
 */
export declare function buildChatFull(chat: StoredChat, participants: StoredChatParticipant[], selfId: number): Buffer;
/**
 * Build channels.channelParticipants#9ab0feaf
 */
export declare function buildChannelParticipants(participants: StoredChatParticipant[], selfId: number): Buffer;
/**
 * Build channels.channelParticipant#dfb80317 for a single participant
 * participant:ChannelParticipant chats:Vector<Chat> users:Vector<User>
 */
export declare function buildChannelParticipantSingle(participant: StoredChatParticipant, chat: StoredChat, selfId: number): Buffer;
/**
 * Build a live updates envelope that includes chats
 */
export declare function buildLiveUpdatesEnvelopeWithChats(updateBuffers: Buffer[], userIds: string[], chatIds: number[], selfId: number, participantSelfId?: number): Buffer;
export declare function buildRpcErrorObject(errorCode: number, errorMessage: string): Buffer;
export declare function buildRpcError(reqMsgId: bigint, errorCode: number, errorMessage: string): Buffer;
//# sourceMappingURL=builders.d.ts.map