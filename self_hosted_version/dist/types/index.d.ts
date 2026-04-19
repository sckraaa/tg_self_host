export interface User {
    id: number;
    accessHash: bigint;
    firstName: string;
    lastName?: string;
    username?: string;
    phone?: string;
    status?: 'online' | 'offline' | 'lastSeen';
    lastSeenAt?: number;
}
export interface Chat {
    id: number;
    accessHash: bigint;
    title: string;
    type: 'private' | 'group' | 'supergroup' | 'channel';
    participantsCount?: number;
}
export interface Message {
    id: number;
    peerId: number;
    peerType: 'user' | 'chat';
    fromId?: number;
    text?: string;
    date: number;
    unread: boolean;
}
export interface Session {
    id: string;
    userId: number;
    dcId: number;
    accessHash: bigint;
    createdAt: number;
    activeUntil: number;
}
export interface AuthKey {
    id: string;
    sessionId: string;
    key: Buffer;
    createdAt: number;
}
//# sourceMappingURL=index.d.ts.map