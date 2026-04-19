import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { handleMTProtoMessage } from '../mtproto/handler.js';
const clients = new Map();
export function startServer(port, host) {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    wss.on('connection', (ws, req) => {
        const clientId = generateClientId();
        clients.set(clientId, ws);
        console.log(`Client connected: ${clientId}`);
        ws.on('message', async (data) => {
            try {
                const response = await handleMTProtoMessage(data, clientId);
                if (response) {
                    ws.send(response);
                }
            }
            catch (error) {
                console.error('MTProto error:', error);
                ws.send(createErrorResponse(error));
            }
        });
        ws.on('close', () => {
            clients.delete(clientId);
            console.log(`Client disconnected: ${clientId}`);
        });
        ws.on('error', (error) => {
            console.error(`Client ${clientId} error:`, error);
            clients.delete(clientId);
        });
    });
    server.listen(port, host, () => {
        console.log(`MTProto server running on ${host}:${port}`);
    });
    return { server, wss };
}
function generateClientId() {
    return `client_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}
function createErrorResponse(error) {
    return Buffer.from(JSON.stringify({ error: String(error) }));
}
export function broadcastToAll(data) {
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}
//# sourceMappingURL=mtproto-server.js.map