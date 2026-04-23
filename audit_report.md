# Аудит Pluma MTProto Backend (`self_hosted_version`)

## Общая статистика

| Метрика | Значение |
|---------|---------|
| TL handlers (`case 0x...`) | **192** |
| handlers.ts | 3,643 строк |
| builders.ts | 2,597 строк |
| messageStore.ts | 2,150 строк |
| DB таблицы | 15 (messages, users, chats, participants, reactions, drafts, media, privacy, ...) |
| Тесты | 2 файла (3,918 строк): `auth-exchange.test.ts`, `conformance.test.ts` |
| Auth | `requireAuth()` — единый guard, 46 вызовов, fallback to SEED_USER_ID убран ✅ |

---

## 🔴 Критические баги

### 1. ✅ Нет проверки `out` flag при доставке получателю — ГОТОВО
**Файл**: [handlers.ts](file:///Users/sckr.a/aaaaaaa/self_hosted_version/src/mtproto/handlers.ts) + [fixtureHelpers.ts](file:///Users/sckr.a/aaaaaaa/self_hosted_version/src/mtproto/fixtureHelpers.ts)

**Как сделано**: добавлен общий хелпер `prepareRecipientFixture(peerKey, msgId, recipientId, senderId)` в `fixtureHelpers.ts`, который всегда выставляет `out=false` и `fromPeerKey=user:<senderId>`. Его теперь вызывают:
- `messages.sendMessage` P2P-доставка (было);
- `messages.sendMessage` group/channel-broadcast (было inline patch-а нет, теперь унифицировано);
- `messages.forwardMessages` P2P-доставка;
- `messages.forwardMessages` group-broadcast.

**Effort**: 🟡 Средний (2 часа)

### 2. ✅ Entities (bold, italic, links, mentions) — ГОТОВО
**Как сделано**:
- **Парсинг**: добавлен `readMessageEntitiesVector(reader)` в `parsers.ts` — поддерживает 18 вариантов TL-конструкторов (bold/italic/code/pre/textUrl/mentionName/spoiler/blockquote/customEmoji/…). `parseSendMessageRequest` теперь пропускает `reply_markup` (flag 2) и читает `entities` (flag 3), возвращая `ParsedMessageEntity[]`.
- **Хранение**: в `app_messages` добавлена колонка `entities BLOB` (миграция через `PRAGMA table_info`). `StoredMessage.entities?: Buffer`, `appendOutgoingMessage({..., entities})`, `mapMessageRow` — колонка ходит сквозь весь путь.
- **Сериализация**: новый `writeMessageEntitiesVector` в `writers.ts` сериализует entities обратно в TL-вектор. `writeMessageFromFixture` выставляет `flag 7` и вставляет BLOB вербатим.
- **Доставка**: сохранённый BLOB копируется в дубликаты сообщения у получателя/участников группы (`sendMessage`) и в gap-recovery пути `updates.getDifference`.

**Результат**: Bold/italic/links/mentions доставляются до получателя без потерь.

---

### 3. ✅ `messages.getWebPagePreview` — ГОТОВО
**Как сделано**: добавлен модуль `utils/webPagePreview.ts` с кешем (TTL 30 мин, макс. 500 записей), асинхронным HTTPS-fetch-ом (5-сек таймаут, 512KB лимит, SSRF-гард на частные IP-диапазоны) и парсером OpenGraph (`og:title`, `og:description`, `og:site_name`, `og:type`, `og:image`, `<title>`).

Handler `messages.getWebPagePreview` извлекает первый URL из `message`, возвращает `buildWebPagePreviewFromOg(...)` с реальными `webPage#e89c45b2` полями, если в кеше есть запись. При первом запросе fetch стартует в фоне и возвращается `WebPagePreviewEmpty`; следующий poll веб-клиента уже получит превью.

---

### 4. ✅ `updates.getDifference` — ПРОВЕРЕНО + улучшено
Существующая реализация в `buildUpdatesDifference` корректно собирает пропущенные события из `listUpdateEventsAfter`, восстанавливает `FixtureMessage` из `app_messages` и возвращает `updates.difference#f49ca0`. Проверено:
- `new_message` события приводят к восстановлению полного `Message` с `replyTo`, `quoteText`, `mediaId`, `fwdFrom…` полями.
- `edit_message`/`delete_messages`/`read_history`/`read_history_outbox` обрабатываются отдельными ветками.

**Улучшение по ходу дела**: в восстанавливаемые `FixtureMessage` теперь прокидывается `entities: stored.entities`, так что форматирование не теряется при gap-recovery (было раньше — entities терялись даже если бы они были сохранены).

---

### 5. ✅ Группы/каналы — ДОРЕАЛИЗОВАНО
Добавлены таблицы `chat_admin_rights` и `chat_banned_rights`, методы `setAdminRights`, `setBannedRights`, `removeChatParticipant`, `updateChatTitle`, `updateChatAbout` в `messageStore.ts`.

**Новые handlers**:
- ✅ `channels.editAdmin` (0xd33c8902) — назначение админов с flags и rank (только creator может)
- ✅ `channels.editBanned` (0x96e6cd81) — бан/кик: сохраняет rights, bit 0 = kick → удаляет из participants
- ✅ `channels.leaveChannel` (0xf836aa95) — удаляет self из participants, шлёт `updateChannel`
- ✅ `channels.editTitle` (0x566decd0) / `channels.editAbout` (0x13e27f1e) — меняет chats row, broadcast участникам
- ✅ `messages.addChatUser` (0xcbc6d107) / `messages.deleteChatUser` (0xa2185cab) — legacy-group управление с service-сообщением `chatDeleteUser`
- ✅ `messages.editChatTitle` (0x73783ffd) / `messages.editChatAbout` (0xdef60797)

**По-прежнему не реализовано** (вне Top-10): `channels.toggleSlowMode`, `channels.toggleJoinRequest`, join по invite link.

---

### 6. ✅ Контакты — РЕАЛИЗОВАНО
**БД**: созданы таблицы `contacts(owner_user_id, contact_user_id, first_name, last_name, phone, date)` и `blocked_users(owner_user_id, blocked_user_id, date)` с методами `addContact`, `deleteContact`, `listContacts`, `isContact`, `blockUser`, `unblockUser`, `listBlockedUsers`, `isBlocked`.

**Handlers**:
- ✅ `contacts.addContact` (0xe8f63c0f) — парсит `InputUser` + имя/телефон, пишет в `contacts`
- ✅ `contacts.deleteContacts` (0x096a0e00) — удаляет по `Vector<InputUser>`
- ✅ `contacts.importContacts` (0x2c800be5) — маппит `inputPhoneContact` → users по `getUserByPhone`, возвращает `contacts.importedContacts#77d01c3b`
- ✅ `contacts.block` (0x2e2e8734) / `contacts.unblock` (0xb550d328)
- ✅ `contacts.getBlocked` (0x9a868f80) — теперь возвращает `buildBlockedFromDb(selfId)` (реальный список peerBlocked + users)
- ✅ `buildContactsFromDb` переписан: возвращает **только** реальные contacts (а не всех пользователей).

---

### 7. ✅ Message entities в forwardMessages — ГОТОВО
**Как сделано**: в трёх местах `messages.forwardMessages` (сохранение у sender, P2P-получатель, group-broadcast) в `appendOutgoingMessage` теперь передаётся `entities: origMsg?.entities` — исходный сериализованный BLOB копируется в пересланные экземпляры. Форматирование оригинала (bold/italic/links/mentions) сохраняется.

---

### 8. ✅ Drafts live push — ГОТОВО
**Как сделано**:
- В `builders.ts` добавлен `buildUpdateDraftMessage(peerKey, text, date, replyToMsgId)` (`updateDraftMessage#ee2bb969`).
- `messages.saveDraft` после записи в SQLite вызывает `ctx.broadcastSessionUpdates(session, envelope)` с `updateDraftMessage` — все остальные сессии пользователя получают draft в реальном времени.
- `messages.getAllDrafts` (0x6a3f8d65) больше не возвращает пустой вектор: проходит по `getAllDrafts(selfId)`, шлёт серию `updateDraftMessage` и список вовлечённых users.

---

### 9. ✅ Notifications settings — ГОТОВО
**БД**: таблица `notify_settings(owner_user_id, peer_key, mute_until, show_previews, silent, updated_at)`. `peer_key` может быть `user:<id>`, `chat:<id>`, `channel:<id>` или global ключи `users`/`chats`/`broadcasts`.

**Handlers**:
- ✅ `account.getNotifySettings` (0x12b3ad31) — парсит `InputNotifyPeer`, читает из `notify_settings`, возвращает `buildPeerNotifySettings({ showPreviews, silent, muteUntil })`.
- ✅ `account.updateNotifySettings` (0x84be5b93) — парсит `InputPeerNotifySettings` (flags.0 show_previews, flags.1 silent, flags.2 mute_until), пишет через `setNotifySettings`.
- `writePeerNotifySettingsToWriter` расширен 2-м параметром `settings` для честной сериализации (`boolTrue`/`boolFalse`, реальный `mute_until`).


---

### 10. ✅ Dialog pin / reorder — ГОТОВО
**БД**: таблица `pinned_dialogs(owner_user_id, peer_key, position, updated_at)` с методами `getPinnedDialogs`, `setDialogPinned`, `reorderPinnedDialogs`, `isDialogPinned`.

**Handlers**:
- ✅ `messages.toggleDialogPin` (0xa731e257) — парсит `flags`+`InputDialogPeer`, вызывает `setDialogPinned(self, peerKey, flags.0)`.
- ✅ `messages.reorderPinnedDialogs` (0x3b1adf37) — читает `Vector<InputDialogPeer>` и атомарно пересохраняет порядок в SQLite-транзакции.
- ✅ `buildPinnedDialogs(selfId)` теперь использует `messageStore.getPinnedDialogs(selfId)` + `buildPeerDialogsForPeers` — возвращает реальный порядок закреплённых диалогов.

---

### 11. Sticker sets — `getStickerSet` имеет частичную реализацию
Animated emojis (constructorId `0xc8a0ec74`) возвращает реальные данные из `data/sticker-sets/`. Все остальные стикер-запросы → `NotModified`. Работает для базового UI, но нет кастомных стикерпаков.

---

## 🔵 Полностью отсутствует

### 12. 2FA (Two-Factor Auth)
`account.getPassword` → «пароль не установлен». Нет SRP-протокола, нет хранения salt/hash. Любой, кто перехватит SMS-код, получит полный доступ.


---

### 13. Секретные чаты (E2E)
Отдельный протокол поверх MTProto. Полностью отсутствует.


---

### 14. Stories
Все `stories.*` → пустые ответы.


---

### 15. Боты / inline запросы
Нет обработки `messages.sendInlineBotResult`, `messages.getBotCallbackAnswer`, webhook/long-polling для ботов.


---

### 16. Push-нотификации
`account.registerDevice` / `account.unregisterDevice` → boolTrue, но FCM/APNs не подключены. Мобильные клиенты не получат push.


---

## 🏗 Архитектура и tech debt

### 17. Монолитный `handlers.ts` — 3,643 строки
Весь RPC routing в одном `switch`. Добавление каждого нового handler увеличивает файл. Нет разделения по domains (auth, messages, channels, phone, account).

**Suggestion**: Разбить на модули: `handlers/messages.ts`, `handlers/channels.ts`, `handlers/account.ts`, etc. Каждый экспортирует `Map<constructorId, handlerFn>`.

---

### 18. Нет structured logging
Все логи через `console.log` с ручным форматированием `[${new Date().toISOString()}]`. Нет JSON-структурированных логов, нет уровней (info/warn/error/debug), нет log rotation.

**Suggestion**: `pino` или `winston` с JSON output для Docker → ELK/Grafana.

---

### 19. Graceful shutdown — минимальный
```ts
process.on('SIGTERM', () => { db.close(); process.exit(0); });

---

### 21. Session cleanup — 30 days TTL
```ts
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
```
Есть periodic cleanup каждый час ✅, есть:
- `account.getAuthorizations` — стаб (строка ~1469), показывает список авторизаций
- `account.resetAuthorization` — реализован, пользователь может отозвать чужую сессию

---

## ✅ Хорошо реализовано

| Фича | Статус | Комментарий |
|------|--------|------------|
| MTProto 2.0 Handshake | ✅ Полный | PQ→DH→auth_key, obfuscation, IGE/CTR |
| Auth flow | ✅ Полный | sendCode→signIn→signUp, rate limiting |
| P2P messaging | ✅ Работает | Полная цепочка send→store→push→badge |
| Media (фото/документы/голосовые) | ✅ Работает | upload→saveMedia→disk persistence→getFile |
| Phone calls (P2P VoIP) | ✅ Полный | request→accept→confirm→discard + DTLS/TURN + signaling |
| Reactions | ✅ Работает | set/remove + live broadcast + aggregation |
| Message edit/delete | ✅ Работает | С live push и pts tracking |
| Search (FTS5) | ✅ Работает | Full-text search, media filters, global search |
| Reply with quote | ✅ Работает | quoteText + quoteOffset + reply serialization |
| Forward messages | ✅ Работает | fwdFrom metadata preserved |
| Privacy rules | ✅ Работает | Privacy per-key (status, phone, etc.) + enforcement |
| Profile editing | ✅ Работает | Photo, name, username, birthday, about |
| Dialogs P2P unread sync | ✅ Починено | Только что исправлен loadTopChats |
| Rate limiting | ✅ Есть | auth: 3/5min, signIn: 5/5min, messages: 30/min, RPC: 300/min |
| Input validation | ✅ Есть | phone, text, name, username, peerKey, messageIds |
| COTURN (STUN/TURN) | ✅ Настроен | docker-compose + turnserver.conf |
| TLS | ✅ Через nginx | certs volume + ACME certbot |
| Auth key persistence | ✅ SQLite | Выживает рестарт сервера |

---

## Итог по Top-10 (выполнено в этом прогоне)

1. ✅ `prepareRecipientFixture` helper + применение в 4 путях
2. ✅ Message entities — parse/store/serialize/forward/gap-recovery
3. ✅ Link previews — OpenGraph fetch + кеш + SSRF-гард
4. ✅ `updates.getDifference` — проверено, добавлено прокидывание `entities`
5. ✅ Группы/каналы: `editAdmin`/`editBanned`/`leaveChannel`/`addChatUser`/`deleteChatUser`/`editTitle`/`editAbout`
6. ✅ Contacts CRUD + block list (таблицы + handlers + `getBlocked`/`getContacts` переведены на реальные данные)
7. ✅ Entities в `forwardMessages`
8. ✅ Draft live push (`updateDraftMessage`) + реальный `getAllDrafts`
9. ✅ Notify settings persistence (table `notify_settings` + `writePeerNotifySettings(settings)`)
10. ✅ Dialog pin/reorder persistence (table `pinned_dialogs` + `buildPinnedDialogs` на реальных данных)

### Остаётся (п. 11+)
- 11. Стикерпаки, 12. 2FA (SRP), 13. Секретные чаты, 14. Stories, 15. Боты/inline, 16. Push (FCM/APNs)
- 17–21. Архитектура: модульный `handlers.ts`, structured logging, graceful shutdown, Prometheus, `account.getAuthorizations`/`resetAuthorization`