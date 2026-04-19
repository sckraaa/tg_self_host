import { WebSocket } from 'ws';
import * as net from 'net';
import { CTR } from '../crypto/utils.js';
export interface ClientSession {
    id: string;
    socket?: WebSocket;
    tcpSocket?: net.Socket;
    send?: (data: Buffer) => void;
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
}
export declare function startServer(port: number, host: string): {
    server: import("http").Server<typeof import("http").IncomingMessage, typeof import("http").ServerResponse>;
    wss: import("ws").Server<typeof WebSocket, typeof import("http").IncomingMessage>;
    tcpServer: net.Server;
    clients: Map<string, ClientSession>;
};
//# sourceMappingURL=server.d.ts.map