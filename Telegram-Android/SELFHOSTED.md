# Self-Hosted Android Client

Это модифицированный Telegram Android клиент, адаптированный для подключения к самохостинговому серверу `pluma.chat` (как `web_client`).

## Внесенные изменения

### 1. API credentials (`BuildVars.java`)
- `APP_ID` → `123456`
- `APP_HASH` → `abcdef1234567890`
- Отключены: SafetyNet, Google Auth, Play Billing, Passkeys

### 2. DC addresses (`ConnectionsManager.cpp`)
- Все официальные IP Telegram (`149.154.x.x`) заменены на `pluma.chat:8443`
- Все 5 DC указывают на один self-hosted сервер
- IPv6 адреса удалены

### 3. Защита от перезаписи DC (`ConnectionsManager.cpp`)
- `updateDcSettings()` отключен (early return)
- Предотвращает случайный переход на официальные сервера Telegram при получении `help.getConfig`

### 4. Link prefix (`MessagesController.java`)
- Default `linkPrefix` изменен с `t.me` на `pluma.chat`

### 5. Deep links (`AndroidManifest.xml`)
- Добавлен `pluma.chat` в intent filters для `http`/`https`

## Сборка

### Требования
- Android Studio 3.4+
- Android NDK rev. 20
- Android SDK 8.1+

### Шаги

1. Откройте проект в Android Studio (**Open**, не Import)
2. Выберите модуль сборки: `TMessagesProj_AppStandalone`
3. Убедитесь, что `../TMessagesProj/config/release.keystore` существует (или создайте свой)
4. Заполните `gradle.properties`:
```
RELEASE_KEY_PASSWORD=your_password
RELEASE_KEY_ALIAS=your_alias
RELEASE_STORE_PASSWORD=your_password
```
5. Соберите flavor `afatStandaloneDebug` (или `afatStandalone` для release)

```bash
./gradlew :TMessagesProj_AppStandalone:assembleAfatStandaloneDebug
```

APK будет в: `TMessagesProj_AppStandalone/build/outputs/apk/afat/standalone/app.apk`

### Переименование пакета (опционально)

Чтобы не конфликтовать с официальным Telegram:
1. Измените `applicationId` в `TMessagesProj_AppStandalone/build.gradle`
2. Измените `package` в `AndroidManifest.xml`
3. Переименуйте Java пакеты (Refactor → Rename в Android Studio)

## Подключение к серверу

Android клиент подключается напрямую по TCP к порту **8443** (MTProto transport), как и любой другой нативный клиент.

Убедитесь, что:
- Ваш сервер запущен (`docker-compose up`)
- Порт `8443` открыт в фаерволе
- TLS/SSL настроен (если используется reverse proxy)

## Ограничения

- Google Play Services (Push, Maps, Billing) всё ещё линкуются, но отключены в коде
- Для полного удаления Firebase нужно модифицировать `build.gradle`
- `telegra.ph`, `telegram.org` ссылки в коде оставлены как есть (не критично для работы сервера)
