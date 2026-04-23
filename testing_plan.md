# План проверки аудита Top-10

Все тесты прогоняются на двух аккаунтах A и B + одной группе (A = creator, B = member). Для пунктов 8 и 10 нужна третья сессия того же A (вторая вкладка / инкогнито).

Деплой крутится в Docker на `root@193.233.89.181:/opt/pluma`.
Логи: `docker logs -f pluma-backend-1`.

SQLite в контейнере: `docker exec -it pluma-backend-1 sqlite3 /app/data/self_hosted.sqlite`.

---

## Пункт 1 — `prepareRecipientFixture` (out flag во всех путях)

**Тесты**:
1. **P2P send** — A пишет B «hello». У B: сообщение слева, аватарка A, уведомление.
2. **P2P forward** — A форвардит B. У B: форварднутое слева, badge «Forwarded from …».
3. **Group send** — A пишет в группу «hi». У B: сообщение слева, `from=A`.
4. **Group forward** — A форвардит в группу. У B: forward как входящий.

---

## Пункт 2 — Message entities (bold/italic/links/mentions)

1. A → B: `**bold** _italic_ ~~strike~~ ||spoiler|| \`code\``.
2. A → B: вставить text-URL (`Ctrl+K` → URL).
3. A → группа: `@username`.
4. A → B: код-блок с языком.
5. **Reload страницы** — форматирование должно сохраниться после F5 (это отдельный путь через `messages.getHistory`).

**SQL**:
```sql
SELECT message_id, text, length(entities) FROM app_messages
 WHERE entities IS NOT NULL ORDER BY message_id DESC LIMIT 5;
```

**Gap-recovery**: закрыть вкладку B, A шлёт жирное сообщение, B открывает вкладку — форматирование сохранено.

---

## Пункт 3 — WebPage preview через OpenGraph

Первый запрос = empty (fetch в фоне), второй = реальное превью.

**Тесты**:
1. A вставляет `https://example.com` → через 1–3 с title `Example Domain`.
2. `https://github.com` → site_name=GitHub.
3. **SSRF-гард**: `http://127.0.0.1:8080` → empty, лог `Refused to fetch private host`.
4. **Таймаут**: недоступный IP → fail через 5 с.
5. **Кеш**: тот же URL второй раз в 30 мин → моментально.

---

## Пункт 4 — `updates.getDifference` (gap recovery)

1. A и B онлайн, B закрывает вкладку.
2. A шлёт B: текст, **жирный** текст, редактирует, удаляет, ставит реакцию.
3. B открывает вкладку → все 5 действий применились.

**Логи**:
```bash
docker logs pluma-backend-1 | grep -E "updates\.getDifference|GETDIFF"
```

---

## Пункт 5 — Группы/каналы (admin/ban/leave/edit)

Супергруппа: A (creator), B и C (members).

| Действие | Ожидание | SQL |
|---|---|---|
| A → B админ с `banUsers`, rank `Мод` | B badge «admin» | `SELECT * FROM chat_admin_rights WHERE user_id=B;` |
| A снимает B | badge пропал | таблица пустая |
| B пытается → C админ | 403 `CHAT_ADMIN_REQUIRED` | — |
| A банит/кикает C | C пропал | `chat_banned_rights.kicked=1`, нет в `chat_participants` |
| A меняет title | title в real-time у всех | `SELECT title FROM chats;` |
| A меняет about | about обновился | `SELECT about FROM chats;` |
| B leaveChannel | группа ушла у B | нет B в `chat_participants` |

**Legacy `chat:`**: `addChatUser` / `deleteChatUser` + service-сообщение `chatDeleteUser`.

---

## Пункт 6 — Contacts + block list

**Contacts**:
1. A → карточка B → «Add to contacts».
   SQL: `SELECT * FROM contacts WHERE owner_user_id=A;` → 1 строка.
2. Экран Contacts в UI показывает **только** B (а не всех пользователей).
3. A удаляет B → таблица пустая, экран пустой.

**Import**: через UI импортировать phone `+71234567890` (C). В ответе `importedContacts` с `user_id=C.id`.

**Block**:
1. A блокирует B → «Blocked users» показывает B.
   SQL: `SELECT * FROM blocked_users WHERE owner_user_id=A AND blocked_user_id=B;`
2. A разблокирует → запись удалилась.

---

## Пункт 7 — Entities в forwardMessages

1. A → B: «**важное**» (жирным).
2. B форвардит это в группу / к C.
3. C видит «**важное**» с сохранённым форматированием.

**SQL**:
```sql
SELECT message_id, substr(hex(entities), 1, 16) FROM app_messages
 WHERE fwd_from_peer_key IS NOT NULL AND entities IS NOT NULL
 ORDER BY message_id DESC LIMIT 3;
-- entities должны начинаться с 15C4B51C (little-endian 0x1cb5c415)
```

---

## Пункт 8 — Draft live push + getAllDrafts

**Live push**:
1. A открыть 2 вкладки (разные session_id: инкогнито/разный браузер).
2. Вкладка 1: в чате с B начать печатать «draft hello» (не отправлять).
3. Вкладка 2: текст черновика должен появиться в инпуте того же чата.

Логи: `Session … messages.saveDraft` + broadcast `updateDraftMessage#ee2bb969`.

**getAllDrafts**:
1. Драфты в чатах с B, C, D.
2. F5 → все 3 драфта сразу видны как pencil-иконка.
3. SQL: `SELECT peer_key, text FROM drafts WHERE owner_user_id=A;` → 3 строки.

A отправляет сообщение → драфт исчезает.

---

## Пункт 9 — Notify settings persistence

1. A → контекст B → «Mute notifications» → Forever / 1 час.
   SQL: `SELECT * FROM notify_settings WHERE owner_user_id=A AND peer_key='user:B';` → `mute_until > 0`.
2. F5 — иконка mute сохранилась.
3. Unmute → `mute_until=0`.
4. Global: «Notifications off for Private Chats» → запись `peer_key='users', silent=1`.

---

## Пункт 10 — Dialog pin / reorder

1. A → ПКМ по чату с B → «Pin to top». Чат всплывает вверх.
   SQL: `SELECT peer_key, position FROM pinned_dialogs WHERE owner_user_id=A;` → `user:B, position=0`.
2. Pin C и D. Drag-n-drop переставить порядок → `position` обновились.
3. F5 → порядок сохранился.
4. Unpin B → запись ушла.

---

## 30-секундный smoke

```text
1. A пинит чат с B, пишет B жирный текст «**hi**» с https://example.com
2. B видит жирный + (через 2-3 сек) webpage-preview
3. B мутит чат с A
4. B форвардит A-сообщение в группу с C → C видит форвард с жирным
5. C делает editTitle группы на «Test group»
6. A видит новый title в real-time
7. A → B в контакты, потом блокирует B
```

Если все 7 шагов прошли — пункты 1–10 минимально работают.
