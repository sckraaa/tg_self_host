# Нереализованные фичи и заглушки (Pluma MTProto Backend)

В этом документе собран полный список методов MTProto и функционала, который на данный момент либо **полностью отсутствует** (не обрабатывается), либо **имеет заглушку** (сервер возвращает пустой список или фейковый `true`, чтобы клиент не падал с ошибками).

## 🔒 Безопасность и сессии
* **2FA (Облачный пароль)**
  * `account.getPassword` всегда возвращает `account.noPassword`.
  * Протокол SRP для верификации облачного пароля не реализован. Любой, у кого есть доступ к СМС-коду (который печатается в логах), может войти в аккаунт.
* **Секретные чаты (End-to-End шифрование)**
  * Протокол E2E поверх MTProto полностью отключен. Методы вроде `messages.requestEncryption` и `messages.acceptEncryption` не обрабатываются.
* **Perfect Forward Secrecy (PFS)**
  * `auth.bindTempAuthKey` просто возвращает `true`. Временные ключи не привязываются.
* **Управление сессиями**
  * `account.getAuthorizations` выдает пустой список сессий. Просмотреть список устройств и завершить другие сессии через UI на данный момент нельзя (хотя `account.resetAuthorization` реализован для принудительного отзыва сессии).

## 🔔 Уведомления и статусы
* **Push-уведомления (APNs / FCM)**
  * `account.registerDevice` и `account.unregisterDevice` возвращают `true`, но токены никуда не сохраняются.
  * Сервер не умеет отправлять push-уведомления на мобильные устройства, если приложение закрыто (требуются официальные сертификаты Apple/Google).
* **Синхронизация статусов "В сети"**
  * `contacts.getStatuses` возвращает пустой список. 
  * Мы не рассылаем всем контактам статус "был(а) недавно" или "онлайн". Статус обновляется только при прямом взаимодействии с пользователем.
* **Точное время прочтения (Premium фича)**
  * `messages.getOutboxReadDate` возвращает пустоту. Сервер хранит только `max_id` прочитанного сообщения, но не точный timestamp.
* **Ручные пометки "Непрочитано"**
  * `messages.getDialogUnreadMarks` (синяя точка при свайпе чата) возвращает пустоту и не сохраняется в БД.

## 🎨 Медиа, стикеры и кастомизация
* **Пользовательские стикерпаки**
  * `messages.uninstallStickerSet` и аналогичные методы модификации возвращают `true`.
  * В БД нет привязки установленных стикерпаков к пользователю. Работают только те базовые паки, которые жестко закешированы на сервере (AnimatedEmoji, EmojiDefaultTopicIcons и т.д.). Сторонние стикеры не устанавливаются.
* **Кастомные премиум-эмодзи**
  * `messages.getCustomEmojiDocuments` жалуется в логах `Serving 0/X documents`, так как сервер не имеет заранее скачанных файлов этих кастомных эмодзи.
* **Эффекты сообщений**
  * `messages.getAvailableEffects` возвращает пустой список.
* **Теги реакций (Premium)**
  * `messages.getSavedReactionTags` и `messages.getDefaultTagReactions` заглушены.
* **Сохраненные диалоги (Папки внутри Избранного)**
  * `messages.getSavedDialogs` и `messages.getPinnedSavedDialogs` возвращают пустоту.

## 📢 Социальные функции и монетизация
* **Stories (Истории)**
  * `stories.getAllStories` и `stories.getPeerStories` возвращают пустые списки. В интерфейсе нет кружочков с историями.
* **Telegram Stars (Звезды) и Подарки**
  * `payments.getStarsStatus`, `payments.getStarGifts`, `payments.getStarGiftActiveAuctions`, `payments.getSavedStarGifts`, `payments.getStarsTopupOptions` полностью заглушены.
  * Пак `TonGifts` выдает ошибку загрузки.
* **Реклама (Sponsored Messages)**
  * `help.getPromoData` возвращает пустой список. Реклама в конце списка чатов отключена на уровне сервера.
* **Коллекционные статусы и юзернеймы**
  * `account.getCollectibleEmojiStatuses` и `account.checkUsername` (возвращает всегда валидно) не взаимодействуют с блокчейном TON.

## 🤖 Боты и каналы
* **Боты и Inline-запросы**
  * Методы `messages.sendInlineBotResult`, `messages.getBotCallbackAnswer` не обрабатываются сервера.
  * Ботов в меню вложений (`messages.getAttachMenuBots`) нет (возвращается пустота).
  * Webhooks и long-polling API для ботов отсутствует.
* **Broadcast-каналы**
  * Обычные группы и супергруппы работают отлично, но чисто вещательные (broadcast) каналы с миллионами подписчиков реализованы частично (`channels.getFullChannel` возвращает заглушку `buildChannelFullEmpty`, `channels.getMessages` выдает пустой список).

## ⚙️ Прочее
* `help.getTimezonesList` — заглушка.
* `account.getContentSettings` (настройки скрытия деликатного контента) — заглушка (возвращает дефолт).
* `help.getTermsOfServiceUpdate` — заглушка.
* `account.getContactSignUpNotification` — заглушка (не рассылаем уведомления "Контакт X теперь в Telegram").

---
*Документ сгенерирован автоматически на основе аудита кода.*
