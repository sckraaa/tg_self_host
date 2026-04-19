import type { FixtureDialog, FixtureMessage, FixtureUser, OfficialCaptureFixture } from './officialCaptureFixture.js';
export declare const SEED_USER_ID = 100000;
export declare function buildActionForFixture(peerKey: string, actionType?: string, text?: string, mediaId?: number): FixtureMessage['action'] | undefined;
export declare function listStoredMessagesAsFixture(peerKey: string, selfId?: number): FixtureMessage[];
export declare function listStoredMessagesAsFixtureForUser(peerKey: string, userId: number): FixtureMessage[];
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