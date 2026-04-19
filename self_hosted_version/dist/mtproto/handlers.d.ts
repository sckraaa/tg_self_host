import type { ClientSession } from './server.js';
export interface HandlerCallbacks {
    authKeyUserMap: Map<string, number>;
    broadcastToUser: (targetUserId: number, responseData: Buffer | null, excludeSessionId?: string) => void;
    broadcastSessionUpdates: (sourceSession: ClientSession, responseData: Buffer | null) => void;
    removeAuthKey: (authKey: Buffer) => void;
}
export declare function handleTlRequest(data: Buffer, session: ClientSession, reqMsgId: bigint, ctx: HandlerCallbacks): Buffer | null;
//# sourceMappingURL=handlers.d.ts.map