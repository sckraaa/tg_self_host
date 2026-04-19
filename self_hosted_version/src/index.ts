import { initDatabase } from './database/schema.js';
import { startServer, startTcpServer } from './mtproto/server.js';
import { ApiHandler } from './api/handler.js';
import { config } from 'dotenv';
import { existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';

config();

const PORT = parseInt(process.env.PORT || '8080');
const TCP_PORT = parseInt(process.env.TCP_PORT || '8443');
const HOST = process.env.HOST || 'localhost';
const DB_PATH = process.env.DB_PATH || './data/telegram.db';

// resolve() correctly handles both absolute and relative DB_PATH values
const absoluteDbPath = resolve(DB_PATH);
const dbDir = dirname(absoluteDbPath);

if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true });
}

console.log('===========================================');
console.log('  Telegram Self-Hosted Backend');
console.log('  Full MTProto 2.0 Compatible Server');
console.log('===========================================');
console.log(`Database: ${absoluteDbPath}`);
console.log(`WebSocket: ${HOST}:${PORT}`);
console.log(`TCP (mobile): ${HOST}:${TCP_PORT}`);
console.log('===========================================');

console.log('Initializing database...');
const db = initDatabase(absoluteDbPath);
console.log('Database initialized');

const api = new ApiHandler(db);
console.log('API handlers initialized');

console.log('Starting MTProto server...');
startServer(PORT, HOST);
startTcpServer(TCP_PORT, HOST);

console.log('');
console.log('===========================================');
console.log('Server is ready!');
console.log('===========================================');
console.log('');
console.log('Supported transports:');
console.log(`  - WebSocket (web clients): ws://${HOST}:${PORT}`);
console.log(`  - TCP (mobile/TDLib):      ${HOST}:${TCP_PORT}`);
console.log('');
console.log('Supported endpoints:');
console.log('  - Authentication (PQ, DH)');
console.log('  - API methods: getConfig, getDialogs, getHistory, etc.');
console.log('');

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  db.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  db.close();
  process.exit(0);
});
