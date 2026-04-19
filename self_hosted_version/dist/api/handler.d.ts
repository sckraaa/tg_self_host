import type { ClientSession } from '../mtproto/server.js';
import type BetterSqlite3 from 'better-sqlite3';
export interface ApiUser {
    id: number;
    accessHash: bigint;
    firstName: string;
    lastName?: string;
    username?: string;
    phone?: string;
    status?: 'offline' | 'online' | 'recently' | 'lastWeek' | 'lastMonth';
    langCode: string;
    isBot: boolean;
    isPremium: boolean;
    isVerified: boolean;
    isRestricted: boolean;
    isScam: boolean;
    isFake: boolean;
    restrictionReason?: string;
}
export interface ApiChat {
    id: number;
    accessHash: bigint;
    title: string;
    type: 'chat' | 'channel' | 'megagroup';
    username?: string;
    participantsCount: number;
    date: number;
    isDeactivated: boolean;
    restrictionReason?: string;
}
export interface ApiMessage {
    id: number;
    peerId: number;
    peerType: 'user' | 'chat' | 'channel';
    fromId?: number;
    text?: string;
    date: number;
    unread: boolean;
    out: boolean;
    media?: string;
    entities?: string;
}
export interface ApiDialog {
    id: number;
    type: 'user' | 'chat' | 'channel';
    unreadCount: number;
    lastMessageId: number;
    lastReadInboxMaxId: number;
    lastReadOutboxMaxId: number;
    date: number;
}
export declare class ApiHandler {
    private db;
    constructor(db: BetterSqlite3.Database);
    handleApiRequest(method: string, params: Record<string, unknown>, session: ClientSession): Promise<Buffer | null>;
    private getAppConfig;
    private getConfig;
    private getPassword;
    private checkUsername;
    private updateUsername;
    private getFullUser;
    private getUsers;
    private getDialogs;
    private getHistory;
    private sendMessage;
    private getChats;
    private getChannels;
    private signIn;
    private signUp;
    private serializeUser;
    private serializeChat;
    private serializeMessages;
    private serializeDialogs;
}
//# sourceMappingURL=handler.d.ts.map