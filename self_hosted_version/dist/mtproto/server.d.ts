import { WebSocket } from 'ws';
import { type Socket } from 'net';
import { CTR } from '../crypto/utils.js';
export interface ClientSession {
    id: string;
    socket?: WebSocket;
    tcpSocket?: Socket;
    sendRaw: (data: Buffer) => void;
    authKey?: Buffer;
    keyId?: bigint;
    dcId: number;
    userId?: number;
    connectedAt: number;
    lastActivityAt: number;
    handshakeComplete?: boolean;
    obfuscated?: boolean;
    encryptor?: CTR;
    decryptor?: CTR;
    serverSalt?: Buffer;
    sessionId?: Buffer;
    sentNewSessionCreated?: boolean;
    layer?: number;
    serverSeqNo: number;
    pendingAckMsgIds: bigint[];
}
export declare function startServer(port: number, host: string): {
    server: import("http").Server<typeof import("http").IncomingMessage, typeof import("http").ServerResponse>;
    wss: import("ws").Server<typeof WebSocket, typeof import("http").IncomingMessage>;
    clients: Map<string, ClientSession>;
};
export declare function startTcpServer(tcpPort: number, host: string): void;
//# sourceMappingURL=server.d.ts.map