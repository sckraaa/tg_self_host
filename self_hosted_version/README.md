# Telegram Self-Hosted Backend

A fully self-hosted Telegram backend implementation with MTProto 2.0 protocol compatibility. If Telegram's servers are ever shut down, your infrastructure won't be affected.

## Features

- **MTProto 2.0 Protocol** - Fully compatible with official Telegram client protocol
- **WebSocket Server** - Low-latency bidirectional communication
- **SQLite Storage** - Lightweight persistent storage for users, chats, and messages
- **Authentication Flow** - PQ (Probabilistic Quorum) and Diffie-Hellman key exchange
- **API Methods** - Core Telegram API methods implemented

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Web Client                              │
│  (Modified Telegram Web - connects to custom server)        │
└─────────────────────────┬─────────────────────────────────┘
                          │ WebSocket / HTTPS
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                  MTProto Server                              │
│  ├── Authentication Handler (PQ, DH Exchange)              │
│  ├── Message Encryption (IGE/CTR)                          │
│  ├── Session Management                                     │
│  └── API Request Router                                     │
└─────────────────────────┬─────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    SQLite Database                          │
│  ├── users          - User accounts & profiles              │
│  ├── chats          - Chats, channels, supergroups         │
│  ├── messages       - All messages                         │
│  ├── dialogs        - User conversations                   │
│  ├── sessions       - Active client sessions               │
│  └── auth_keys      - MTProto authentication keys           │
└─────────────────────────────────────────────────────────────┘
```

## Protocol Details

### MTProto 2.0 Message Format

**Plain Message (before auth):**
```
auth_key_id: 0
message_id: int64
message_data_length: int32
message_data: bytes
```

**Encrypted Message (after auth):**
```
auth_key_id: int64
msg_key: int64  
encrypted_data: bytes (IGE encrypted)
```

### Authentication Flow

1. **ReqPqMulti** - Client sends nonce, server returns ResPQ with server_nonce
2. **ReqDHParams** - Client sends p, q, encrypted_data for DH parameters
3. **SetClientDHParams** - Client sends DH inner data, server responds with DhGenOk

### Message Encryption

Uses AES-256 in IGE (Cipher Feedback) mode with:
- msg_key derived from SHA256(auth_key[88:120] + plaintext + padding)
- Key material calculated via multiple SHA256 operations

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure environment:
```bash
cp .env.example .env
# Edit .env with your settings
```

3. Build:
```bash
npm run build
```

4. Run:
```bash
npm start
# or for development:
npm run dev
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 8080 | Server port |
| HOST | localhost | Server host |
| DB_PATH | ./data/telegram.db | Path to SQLite database |

## Connecting Clients

### Web Client Modification

In `src/util/mtprotoServer.ts`, modify `resolveDcAddress`:

```typescript
export function resolveDcAddress(
  serverConfig: ApiServerConfig | undefined,
  dcId: number,
  downloadDC = false,
) {
  // Your self-hosted server address
  const host = 'your-server.example.com';
  const port = 443;

  return {
    id: dcId,
    ipAddress: host,
    port: port,
  };
}
```

### Mobile Client

Configure your MTProto proxy to point to your server address.

## API Methods Supported

| Method | Status |
|-------|--------|
| help.getAppConfig | ✅ |
| help.getConfig | ✅ |
| account.getPassword | ✅ |
| account.checkUsername | ✅ |
| users.getFullUser | ✅ |
| users.getUsers | ✅ |
| messages.getDialogs | ✅ |
| messages.getHistory | ✅ |
| messages.sendMessage | ✅ |
| messages.getChats | ✅ |
| auth.signIn | ✅ |
| auth.signUp | ✅ |

## Database Schema

See `src/database/schema.ts` for the complete database structure.

## Security

- All messages encrypted with AES-256-IGE after authentication
- Auth keys are unique per session
- Server nonce prevents replay attacks
- DH key exchange uses 2048-bit prime

## Limitations

This is an educational/prototype implementation. For production use, consider:

- PostgreSQL for multi-server deployment
- Redis for session storage
- Proper load balancing
- Certificate-based TLS
- Rate limiting and DDoS protection

## License

MIT
