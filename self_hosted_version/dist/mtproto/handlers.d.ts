import type { ClientSession } from './server.js';
export interface HandlerCallbacks {
    authKeyUserMap: Map<string, number>;
    broadcastToUser: (targetUserId: number, responseData: Buffer | null, excludeSessionId?: string) => void;
    broadcastSessionUpdates: (sourceSession: ClientSession, responseData: Buffer | null) => void;
    removeAuthKey: (authKey: Buffer) => void;
    /**
     * Send a deferred rpc_result for a request that returned `null` synchronously.
     * Used for handlers that must wait on an out-of-process operation (e.g. the
     * OpenGraph fetch in `messages.getWebPagePreview`) without blocking the TL
     * dispatch loop. `payload` is the raw TL object the client expects as the
     * result type — it gets wrapped in rpc_result + encrypted before send.
     */
    sendDeferredRpcResult: (session: ClientSession, reqMsgId: bigint, payload: Buffer) => void;
}
export declare function handleTlRequest(data: Buffer, session: ClientSession, reqMsgId: bigint, ctx: HandlerCallbacks): Buffer | null;
//# sourceMappingURL=handlers.d.ts.map