# Priority 1: API Stubs для основного UI

## Critical Path (блокирует рендер)
- [x] `users.getFullUser` (0x6628562c) — `InputUserSelf` → seed user
- [x] `users.getUsers` (0x0d91a548) — Vector<InputUser> → Vector<User>
- [x] `messages.getDialogFilters` (0xb60f5918) → empty filters
- [x] `messages.getDialogs` (0xefd48c89) → empty dialogs
- [x] `messages.getPeerDialogs` (0x735787a8) → empty peer dialogs
- [x] `help.getNearestDc` (0x1fb33026) → nearestDc
- [x] `account.updateStatus` (0xa0f4cb4f) → boolTrue

## Secondary (предотвращает ошибки)
- [x] `contacts.getContacts` (0x5dd69e12) → empty contacts
- [x] `messages.getDialogUnreadMarks` (0xb288bc7d) → empty vector
- [x] `account.getNotifySettings` (0xa622aa10) → default settings
- [x] `help.getPromoData` (0x9b9240a6) → promoDataEmpty
- [x] `account.getWallPapers` (0xe470bcfd) → wallPapersNotModified
- [x] `messages.getStickerSet` (0x150b3b4c) → stickerSetNotModified
- [x] `auth.exportLoginToken` (0xb7e085fe) → loginToken
- [x] `help.getAppChangelog` (0x72d4742c) → empty updates

## Bonus (дополнительные stubs)
- [x] `contacts.getTopPeers` → topPeersDisabled
- [x] `contacts.getBlocked` → empty blocked
- [x] `messages.getAvailableReactions` → notModified
- [x] `account.getGlobalPrivacySettings` → defaults
- [x] `messages.getAttachMenuBots` → notModified
- [x] `account.getPassword` → no password set
- [x] `messages.getAllStickers` → notModified
- [x] `messages.getFeaturedStickers` → notModified
- [x] `messages.getRecentStickers` → notModified
- [x] `messages.getSavedGifs` → notModified
- [x] `messages.getFavedStickers` → notModified
- [x] `messages.getDefaultHistoryTTL` → period=0
- [x] `messages.getPinnedDialogs` → empty
- [x] `account.getContentSettings` → defaults
- [x] `messages.getEmojiKeywords` → empty diff
- [x] `messages.getRecentReactions` / `getTopReactions` → notModified

## Infrastructure
- [x] Добавлен `writeTlBytes()` helper
- [x] Добавлен `writeUser()` reusable serializer
- [x] Обновить walkthrough.md

## Verification
- [x] Сервер компилируется и запускается без ошибок
- [ ] Клиент подключается и рендерит Main UI (ожидает ручной проверки)
