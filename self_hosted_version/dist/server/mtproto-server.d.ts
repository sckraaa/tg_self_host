import { WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
export declare function startServer(port: number, host: string): {
    server: import("http").Server<typeof IncomingMessage, typeof import("http").ServerResponse>;
    wss: import("ws").Server<typeof WebSocket, typeof IncomingMessage>;
};
export declare function broadcastToAll(data: Buffer): void;
//# sourceMappingURL=mtproto-server.d.ts.map