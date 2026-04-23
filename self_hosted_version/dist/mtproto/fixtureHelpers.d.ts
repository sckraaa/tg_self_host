import type { FixtureDialog, FixtureMessage, FixtureUser, OfficialCaptureFixture } from './officialCaptureFixture.js';
export declare const SEED_USER_ID = 100000;
export declare function buildActionForFixture(peerKey: string, actionType?: string, text?: string, mediaId?: number): FixtureMessage['action'] | undefined;
export declare function listStoredMessagesAsFixture(peerKey: string, selfId?: number): FixtureMessage[];
export declare function listStoredMessagesAsFixtureForUser(peerKey: string, userId: number): FixtureMessage[];
/**
 * Build the FixtureMessage that should be delivered to a **recipient** of a P2P or
 * group/channel message we just stored on their side.
 *
 * Rationale: when we duplicate a message into the recipient's store, the freshly
 * inserted row is `is_outgoing=1` (see `appendOutgoingMessage`). We then call
 * `markMessageIncoming` to flip the DB flag, but `getStoredMessageAsFixture`
 * recomputes `out` from whatever state it re-reads. For broadcast fixtures we
 * must strictly enforce `out=false` and `fromPeerKey=<sender>`, otherwise the
 * recipient client will see the incoming message as one of *their own* outgoing
 * ones (wrong avatar, wrong alignment, no notification).
 *
 * This helper consolidates that post-hoc patch so we never forget to apply it
 * in forwardMessages / group-broadcast paths (see audit item #1).
 */
export declare function prepareRecipientFixture(peerKey: string, messageId: number, recipientUserId: number, senderUserId: number): FixtureMessage | undefined;
export declare function getStoredMessageAsFixture(peerKey: string, messageId: number, selfId?: number): FixtureMessage | undefined;
export declare function mergeMessagesById(messages: FixtureMessage[]): FixtureMessage[];
export declare function mergeDialogWithMessages(dialog: FixtureDialog, messages: FixtureMessage[]): FixtureDialog;
export declare function buildTopDialogMessage(peerKey: string, baseMessage?: FixtureMessage): FixtureMessage | undefined;
export declare function createDialogFromMessage(peerKey: string, message: FixtureMessage): FixtureDialog;
export declare function sliceHistoryMessages(messages: FixtureMessage[], offsetId: number, limit: number): FixtureMessage[];
export declare function collectChatIdsFromMessages(baseChatIds: string[], messages: FixtureMessage[]): string[];
export declare function collectUserIdsFromMessages(baseUserIds: string[], messages: FixtureMessage[]): string[];
export declare function collectEntityIdsFromPeerKey(peerKey: string, userIds: string[], chatIds: string[]): void;
export declare function getReadStateForPeerKey(peerKey: string, selfId: number, fixtureDialog?: FixtureDialog): {
    readInboxMaxId: number;
    readOutboxMaxId: number;
};
export declare function applyStoredDialogState(dialog: FixtureDialog, selfId?: number): FixtureDialog;
export declare function getHighestObservedMessageId(fixture: OfficialCaptureFixture, peerKey: string): number;
export declare function getFixtureUserForId(fixture: OfficialCaptureFixture | undefined, userId: string, isSelf?: boolean): FixtureUser;
//# sourceMappingURL=fixtureHelpers.d.ts.map