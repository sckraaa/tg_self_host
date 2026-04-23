import { BinaryWriter } from './codec.js';
import { type StoredMedia, type StoredChat } from '../database/messageStore.js';
import type { FixtureChat, FixtureDialog, FixtureMessage, FixtureUser, OfficialCaptureFixture } from './officialCaptureFixture.js';
/**
 * Check if a viewer is allowed to see a particular privacy-protected field of a target user.
 * Returns true if the field should be VISIBLE to the viewer.
 */
export declare function isFieldVisibleByPrivacy(targetUserId: number, viewerId: number, privacyKey: string): boolean;
export declare function writePeerByKey(w: BinaryWriter, peerKey: string): void;
export declare function writeMessageFromFixture(w: BinaryWriter, message: FixtureMessage): void;
export declare function writePhotoObject(w: BinaryWriter, media: StoredMedia): void;
export declare function writeUserFromFixture(w: BinaryWriter, user: FixtureUser, viewerId?: number): void;
export declare function writeFallbackUserFromId(w: BinaryWriter, userId: string): void;
export declare function writeChatFromFixture(w: BinaryWriter, chat: FixtureChat): void;
/** Write a basic group chat from StoredChat */
export declare function writeChatFromDb(w: BinaryWriter, chat: StoredChat, selfId: number): void;
export declare function writeChannelFromFixture(w: BinaryWriter, chat: FixtureChat): void;
export declare function writeDialogFromFixture(w: BinaryWriter, dialog: FixtureDialog): void;
export declare function writeDialogVector(w: BinaryWriter, dialogs: FixtureDialog[]): void;
export declare function writeMessageVector(w: BinaryWriter, messages: FixtureMessage[]): void;
export declare function writeUserVector(w: BinaryWriter, fixture: OfficialCaptureFixture, userIds: string[]): void;
export declare function writeChatVector(w: BinaryWriter, fixture: OfficialCaptureFixture, chatIds: string[]): void;
export declare function writePeerNotifySettingsToWriter(w: BinaryWriter, settings?: {
    showPreviews?: boolean;
    silent?: boolean;
    muteUntil?: number;
}): void;
/**
 * Serialize a parsed MessageEntity list back to a TL `Vector<MessageEntity>` buffer
 * (audit #2). The returned buffer can be stored in SQLite and later written into
 * any TL stream verbatim to preserve bold/italic/links/mentions.
 */
export declare function writeMessageEntitiesVector(w: BinaryWriter, entities: Array<{
    type: string;
    offset: number;
    length: number;
    url?: string;
    userId?: number;
    language?: string;
    documentId?: string;
    collapsed?: boolean;
}>): void;
export declare function writeDraftMessageEmpty(w: BinaryWriter, date: number): void;
export declare function writeDraftMessage(w: BinaryWriter, text: string, date: number, replyToMsgId?: number): void;
export declare function writeChatPhotoEmpty(w: BinaryWriter): void;
export declare function writePhotoEmpty(w: BinaryWriter, photoId: bigint): void;
export declare function writeUpdatesStateToWriter(w: BinaryWriter, userId?: number): void;
export declare function writePeerColorSet(w: BinaryWriter, colors: number[]): void;
export declare function writePeerColorProfileSet(w: BinaryWriter, colors: number[]): void;
//# sourceMappingURL=writers.d.ts.map