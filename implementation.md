# Priority 1: API Stubs для основного UI

После успешного handshake, загрузки Config, LangPack и Main bundle — клиент начинает вызывать API-методы для рендера интерфейса. Сейчас сервер логирует `unhandled TL: 0x...` и не отвечает, из-за чего UI остаётся пустым.

## Цель

Добавить TL-binary ответы для всех методов Приоритета 1, чтобы клиент получил:
- Пустой, но валидный список диалогов
- Информацию о текущем пользователе
- Подтверждение онлайн-статуса
- Info о ближайшем DC

---

## Proposed Changes

### 1. Server TL Request Router

#### [MODIFY] [server.ts](file:///Users/sckr.a/telegram_reverse/self_hosted_version/src/mtproto/server.ts)

Добавить новые case'ы в `handleTlRequest()`:

| Constructor ID | Метод | Ответ |
|---------------|-------|-------|
| `0xb60f5918` | `messages.getDialogFilters` | `messages.dialogFilters#d95ef153` — empty vector |
| `0xefd48c89` | `messages.getDialogs` | `messages.dialogsSlice#71e094f3` — empty, pts=1, count=0 |
| `0x735787a8` | `messages.getPeerDialogs` | `messages.peerDialogs#3407e51b` — empty |
| `0x1fb33026` | `help.getNearestDc` | `nearestDc#8e1a1775` — country="US", this_dc=2, nearest_dc=2 |
| `0xa0f4cb4f` | `account.updateStatus` | `boolTrue#997275b5` |
| `0x6628562c` | `users.getFullUser` | `users.userFull#3b6d152e` — seed user данные |
| `0x0d91a548` | `users.getUsers` | Vector<User> — seed user |
| `0xb288bc7d` | `messages.getDialogUnreadMarks` | empty vector |
| `0xa622aa10` | `account.getNotifySettings` | `peerNotifySettings#99622c0c` — defaults |
| `0x72d4742c` | `help.getAppChangelog` | `updates#74ae4240` — empty |
| `0x9b9240a6` | `help.getPromoData` | `help.promoDataEmpty#98f6ac75` |
| `0xe470bcfd` | `account.getWallPapers` | `account.wallPapersNotModified#1c199183` |

Также нужно обработать:
- `0xd45ab096` — `contacts.getContacts` → `contacts.contacts#eae87e42` (empty)
- `0xf8dcc872` — `account.getDefaultEmojiStatuses` → empty vector
- `0x150b3b4c` — `messages.getStickerSet` → `messages.stickerSetNotModified#d3f924eb`
- `0x2dbc4313` — `messages.getEmojiStickers` → `messages.allStickers#cdbbcebb` (empty)

---

### 2. Seed User при подключении

#### [MODIFY] [server.ts](file:///Users/sckr.a/telegram_reverse/self_hosted_version/src/mtproto/server.ts)

При запросе `users.getFullUser` с `inputUserSelf` (constructor `0xb60f5918`... нет, `inputUserSelf#f7c1b13f`):
- Создать seed user с `id=777000`, `first_name="User"`, `access_hash=0`
- Привязать `session.userId = 777000`

Это позволит клиенту корректно отрендерить профиль и список чатов.

---

### 3. New Serialization Helpers

#### [MODIFY] [server.ts](file:///Users/sckr.a/telegram_reverse/self_hosted_version/src/mtproto/server.ts)

Новые builder-функции (всё в TL-binary, не JSON):

```
buildDialogFilters()        → messages.dialogFilters#d95ef153  
buildDialogsEmpty()         → messages.dialogs#15ba6c40 (empty)
buildPeerDialogs()          → messages.peerDialogs#3407e51b (empty)
buildNearestDc()            → nearestDc#8e1a1775
buildBoolTrue()             → boolTrue#997275b5
buildUserFull()             → users.userFull#3b6d152e
buildUser()                 → user#215c4438
buildContactsEmpty()        → contacts.contacts#eae87e42 (empty)
```

---

## Open Questions

> [!IMPORTANT]  
> **User ID**: Использовать `777000` (Telegram system user) как seed ID или сгенерировать рандомный? 777000 может вызвать конфликты если клиент это проверяет.

> [!IMPORTANT]
> **ApiHandler**: Сейчас `ApiHandler` класс с SQLite использует JSON-сериализацию. Он **не подключён** к MTProto серверу. Нужно ли интегрировать его сейчас или просто хардкодить TL stubs напрямую в server.ts? Предлагаю сначала хардкод-stubs, потом рефакторинг на SQLite.

---

## Verification Plan

### Automated Tests
```bash
cd /Users/sckr.a/telegram_reverse/self_hosted_version && npm run dev
```
Запустить сервер, подключить web_client, проверить:
1. Нет `unhandled TL` для методов приоритета 1 в логах
2. Клиент не крашится, UI рендерит пустой список диалогов
3. Профиль пользователя доступен

### Manual Verification
- Открыть web_client в браузере
- Убедиться что Main UI рендерится без ошибок в консоли
- Проверить что пустой список чатов отображается корректно
