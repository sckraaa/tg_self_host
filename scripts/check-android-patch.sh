#!/bin/bash
# Проверяет, что Android-клиент адаптирован под self-hosted сервер

set -e

echo "=== Checking Android client self-host patches ==="

ERRORS=0

# 1. Check BuildVars.java
if grep -q 'APP_ID = 123456' /Users/sckr.a/aaaaaaa/Telegram-Android/TMessagesProj/src/main/java/org/telegram/messenger/BuildVars.java; then
    echo "[OK] BuildVars.java: APP_ID = 123456"
else
    echo "[FAIL] BuildVars.java: APP_ID not patched"
    ERRORS=$((ERRORS+1))
fi

if grep -q 'APP_HASH = "abcdef1234567890"' /Users/sckr.a/aaaaaaa/Telegram-Android/TMessagesProj/src/main/java/org/telegram/messenger/BuildVars.java; then
    echo "[OK] BuildVars.java: APP_HASH patched"
else
    echo "[FAIL] BuildVars.java: APP_HASH not patched"
    ERRORS=$((ERRORS+1))
fi

# 2. Check ConnectionsManager.cpp
if grep -q 'pluma.chat' /Users/sckr.a/aaaaaaa/Telegram-Android/TMessagesProj/jni/tgnet/ConnectionsManager.cpp; then
    echo "[OK] ConnectionsManager.cpp: DC addresses patched to pluma.chat"
else
    echo "[FAIL] ConnectionsManager.cpp: DC addresses not patched"
    ERRORS=$((ERRORS+1))
fi

if grep -q 'Self-hosted: ignore server-side dc_options' /Users/sckr.a/aaaaaaa/Telegram-Android/TMessagesProj/jni/tgnet/ConnectionsManager.cpp; then
    echo "[OK] ConnectionsManager.cpp: updateDcSettings disabled"
else
    echo "[FAIL] ConnectionsManager.cpp: updateDcSettings not disabled"
    ERRORS=$((ERRORS+1))
fi

# 3. Check MessagesController.java
if grep -q 'linkPrefix", "pluma.chat"' /Users/sckr.a/aaaaaaa/Telegram-Android/TMessagesProj/src/main/java/org/telegram/messenger/MessagesController.java; then
    echo "[OK] MessagesController.java: linkPrefix = pluma.chat"
else
    echo "[FAIL] MessagesController.java: linkPrefix not patched"
    ERRORS=$((ERRORS+1))
fi

# 4. Check AndroidManifest.xml
if grep -q 'android:host="pluma.chat"' /Users/sckr.a/aaaaaaa/Telegram-Android/TMessagesProj/src/main/AndroidManifest.xml; then
    echo "[OK] AndroidManifest.xml: pluma.chat deep links added"
else
    echo "[FAIL] AndroidManifest.xml: pluma.chat deep links not added"
    ERRORS=$((ERRORS+1))
fi

if [ "$ERRORS" -eq 0 ]; then
    echo ""
    echo "=== All patches applied successfully ==="
    exit 0
else
    echo ""
    echo "=== $ERRORS check(s) failed ==="
    exit 1
fi
