export class ApiHandler {
    db;
    constructor(db) {
        this.db = db;
    }
    async handleApiRequest(method, params, session) {
        switch (method) {
            case 'help.getAppConfig':
                return this.getAppConfig();
            case 'help.getConfig':
                return this.getConfig();
            case 'account.getPassword':
                return this.getPassword();
            case 'account.checkUsername':
                return this.checkUsername(params);
            case 'account.updateUsername':
                return this.updateUsername(params, session);
            case 'users.getFullUser':
                return this.getFullUser(params);
            case 'users.getUsers':
                return this.getUsers(params);
            case 'messages.getDialogs':
                return this.getDialogs(params);
            case 'messages.getHistory':
                return this.getHistory(params);
            case 'messages.sendMessage':
                return this.sendMessage(params, session);
            case 'messages.getChats':
                return this.getChats(params);
            case 'channels.getChannels':
                return this.getChannels(params);
            case 'auth.signIn':
                return this.signIn(params, session);
            case 'auth.signUp':
                return this.signUp(params, session);
            default:
                console.log(`Unhandled API method: ${method}`);
                return null;
        }
    }
    getAppConfig() {
        return Buffer.from(JSON.stringify({
            _: 'config',
            testMode: false,
            this_dc: 2,
            dc_options: [],
            chat_size_max: 10000,
            megagroup_size_max: 100000,
            forwarded_count_max: 100,
            mode_1: 1,
            mode_2: 2,
            mode_3: 3,
            mode_4: 4,
            mode_5: 5,
            fwd_user_percentage: 50,
            fwd_chat_percentage: 50,
            sticker_size_limit: 512000,
            caption_length_max: 1024,
            chat_dir_size_max: 1000000,
            push_chat_limit: 100000,
            edit_limit: 3600,
            edit_time_limit: 600,
            revoke_time_limit: 600,
            revoke_pm_time_limit: 600,
            vote_quorum: 10,
            pins_count_limit: 10,
            saved_count_limit: 100,
            sequence_min_bit_size: 10,
            sequence_max_bit_size: 64,
            dict_default_length: 100,
            dict_max_length: 100000,
            message_entity_version: 1,
            bill_boards: true,
        }));
    }
    getConfig() {
        const configs = this.db.prepare('SELECT * FROM update_state WHERE id = 1').get();
        return Buffer.from(JSON.stringify({
            _: 'config',
            date: Math.floor(Date.now() / 1000),
            expires: Math.floor(Date.now() / 1000) + 3600,
            testMode: false,
            this_dc: 2,
            dc_options: [],
            chat_size_max: 10000,
            megagroup_size_max: 100000,
            saved_count_limit: 100,
        }));
    }
    getPassword() {
        return Buffer.from(JSON.stringify({
            _: 'account.password',
            flags: 0,
            current_algo: null,
            hint: '',
            has_recovery: false,
            has_secure_values: false,
            has_wallet: false,
            has_unconfirmed_wallet: false,
            password_algorithm: null,
            password_salt: Buffer.alloc(0),
        }));
    }
    checkUsername(params) {
        const username = params.username;
        const existing = this.db.prepare('SELECT id FROM users WHERE username = ?').get(username);
        if (existing) {
            return Buffer.from(JSON.stringify({ _: 'boolFalse' }));
        }
        return Buffer.from(JSON.stringify({ _: 'boolTrue' }));
    }
    updateUsername(params, session) {
        if (!session.userId) {
            return Buffer.from(JSON.stringify({ _: 'rpc_error', error_code: 401, error_message: 'SESSION_REVOKED' }));
        }
        const username = params.username;
        this.db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, session.userId);
        const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(session.userId);
        return this.serializeUser(user);
    }
    getFullUser(params) {
        const userId = params.id;
        const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        if (!user) {
            return Buffer.from(JSON.stringify({ _: 'userEmpty', id: 0 }));
        }
        return this.serializeUser(user);
    }
    getUsers(params) {
        const ids = params.id;
        const users = ids.map(id => {
            const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
            return user ? this.serializeUser(user) : Buffer.from(JSON.stringify({ _: 'userEmpty', id }));
        });
        return Buffer.concat(users);
    }
    getDialogs(params) {
        const offset = params.offset || 0;
        const limit = params.limit || 20;
        const dialogs = this.db.prepare(`
      SELECT d.*, u.first_name, u.username, u.phone, u.status, u.is_bot
      FROM dialogs d
      LEFT JOIN users u ON d.id = u.id AND d.type = 'user'
      ORDER BY d.last_message_id DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
        return this.serializeDialogs(dialogs);
    }
    getHistory(params) {
        const peerId = params.peer_id;
        const offset = params.offset || 0;
        const limit = params.limit || 20;
        const maxId = params.max_id || 0;
        const messages = this.db.prepare(`
      SELECT * FROM messages
      WHERE peer_id = ? AND id < ?
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `).all(peerId, maxId, limit, offset);
        return this.serializeMessages(messages);
    }
    sendMessage(params, session) {
        if (!session.userId) {
            return Buffer.from(JSON.stringify({ _: 'rpc_error', error_code: 401, error_message: 'UNAUTHORIZED' }));
        }
        const peerId = params.peer_id;
        const text = params.message;
        const randomId = params.random_id;
        const result = this.db.prepare(`
      INSERT INTO messages (peer_id, peer_type, from_id, text, date, unread, out, random_id)
      VALUES (?, 'user', ?, ?, ?, 1, 1, ?)
    `).run(peerId, session.userId, text, Math.floor(Date.now() / 1000), randomId);
        return Buffer.from(JSON.stringify({
            _: 'message',
            id: result.lastInsertRowid,
            peer_id: { _: 'peerUser', user_id: peerId },
            date: Math.floor(Date.now() / 1000),
            message: text,
            out: true,
        }));
    }
    getChats(params) {
        const ids = params.id;
        const chats = ids.map(id => {
            const chat = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
            return chat ? this.serializeChat(chat) : Buffer.from(JSON.stringify({ _: 'chatEmpty', id }));
        });
        return Buffer.from(JSON.stringify({
            _: 'messages.chats',
            chats,
        }));
    }
    getChannels(params) {
        return this.getChats(params);
    }
    signIn(params, session) {
        const phone = params.phone_number;
        const code = params.code;
        const user = this.db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
        if (user) {
            session.userId = user.id;
            return this.serializeUser(user);
        }
        return Buffer.from(JSON.stringify({ _: 'rpc_error', error_code: 400, error_message: 'PHONE_CODE_INVALID' }));
    }
    signUp(params, session) {
        const phone = params.phone_number;
        const firstName = params.first_name;
        const lastName = params.last_name;
        const result = this.db.prepare(`
      INSERT INTO users (id, access_hash, first_name, last_name, phone, status, lang_code)
      VALUES (?, ?, ?, ?, ?, 'offline', 'en')
    `).run(Math.floor(Math.random() * 0xFFFFFF), BigInt(Math.floor(Math.random() * 0xFFFFFF)), firstName, lastName || null, phone);
        const user = {
            id: result.lastInsertRowid,
            accessHash: BigInt(0),
            firstName,
            lastName,
            langCode: 'en',
            isBot: false,
            isPremium: false,
            isVerified: false,
            isRestricted: false,
            isScam: false,
            isFake: false,
        };
        session.userId = user.id;
        return this.serializeUser(user);
    }
    serializeUser(user) {
        return Buffer.from(JSON.stringify({
            _: 'user',
            id: user.id,
            access_hash: user.accessHash,
            first_name: user.firstName,
            last_name: user.lastName || null,
            username: user.username || null,
            phone: user.phone || null,
            status: user.status ? { _: `userStatus${user.status.charAt(0).toUpperCase() + user.status.slice(1)}` } : { _: 'userStatusEmpty' },
            lang_code: user.langCode,
            bot: user.isBot ? { _: 'userStatusEmpty' } : null,
            verified: user.isVerified,
            restricted: user.isRestricted,
            scam: user.isScam,
            fake: user.isFake,
        }));
    }
    serializeChat(chat) {
        return Buffer.from(JSON.stringify({
            _: chat.type === 'channel' ? 'channel' : 'chat',
            id: chat.id,
            access_hash: chat.accessHash,
            title: chat.title,
            username: chat.username || null,
            date: chat.date,
            participants_count: chat.participantsCount,
            deactivated: chat.isDeactivated ? true : null,
        }));
    }
    serializeMessages(messages) {
        return Buffer.from(JSON.stringify({
            _: 'messages.messages',
            messages: messages.map(m => ({
                _: 'message',
                id: m.id,
                peer_id: { _: `peer${m.peerType.charAt(0).toUpperCase() + m.peerType.slice(1)}`, [`${m.peerType}_id`]: m.peerId },
                from_id: m.fromId ? { _: 'peerUser', user_id: m.fromId } : null,
                date: m.date,
                message: m.text || '',
                out: m.out,
                unread: m.unread,
            })),
            chats: [],
            users: [],
        }));
    }
    serializeDialogs(dialogs) {
        return Buffer.from(JSON.stringify({
            _: 'messages.dialogs',
            dialogs: dialogs.map(d => ({
                _: 'dialog',
                peer: { _: `peer${d.type.charAt(0).toUpperCase() + d.type.slice(1)}`, [`${d.type}_id`]: d.id },
                top_message: d.lastMessageId,
                unread_count: d.unreadCount,
                last_message_id: d.lastMessageId,
                date: d.date,
                pts: 0,
                folder_id: 0,
            })),
            messages: [],
            chats: [],
            users: [],
        }));
    }
}
//# sourceMappingURL=handler.js.map