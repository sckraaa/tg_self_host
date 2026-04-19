import type { ApiSessionData } from '../api/types';
import type { DcId, SharedSessionData } from '../types';

import {
  DC_IDS,
  DEBUG, IS_SCREEN_LOCKED_CACHE_KEY,
  SESSION_ACCOUNT_PREFIX,
  SESSION_LEGACY_USER_KEY,
} from '../config';
import { isServerConfigScopeCompatible, readCurrentServerConfigScope } from './mtprotoServer';
import { ACCOUNT_SLOT, storeAccountData, writeSlotSession } from './multiaccount';

export function hasStoredSession(serverConfigScope = readCurrentServerConfigScope()) {
  if (checkSessionLocked()) {
    return true;
  }

  const slotData = loadSlotSession(ACCOUNT_SLOT, serverConfigScope);
  if (slotData) return Boolean(slotData.dcId);

  if (!ACCOUNT_SLOT) {
    const legacyAuthJson = localStorage.getItem(SESSION_LEGACY_USER_KEY);
    if (legacyAuthJson) {
      try {
        const userAuth = JSON.parse(legacyAuthJson);
        return Boolean(userAuth && userAuth.id && userAuth.dcID
          && isServerConfigScopeCompatible(userAuth.serverConfigScope, serverConfigScope));
      } catch (err) {
        // Do nothing.
        return false;
      }
    }
  }

  return false;
}

export function storeSession(sessionData: ApiSessionData) {
  const {
    mainDcId, keys, isTest, serverConfigScope,
  } = sessionData;

  const currentSlotData = loadSlotSession(ACCOUNT_SLOT, serverConfigScope);
  const newSlotData: SharedSessionData = {
    ...currentSlotData,
    dcId: mainDcId,
    isTest,
    serverConfigScope,
  };

  Object.keys(keys).map(Number).forEach((dcId) => {
    newSlotData[`dc${dcId as DcId}_auth_key`] = keys[dcId];
  });

  if (!ACCOUNT_SLOT) {
    storeLegacySession(sessionData, currentSlotData?.userId);
  }

  writeSlotSession(ACCOUNT_SLOT, newSlotData);
}

function storeLegacySession(sessionData: ApiSessionData, currentUserId?: string) {
  const {
    mainDcId, keys, isTest, serverConfigScope,
  } = sessionData;

  localStorage.setItem(SESSION_LEGACY_USER_KEY, JSON.stringify({
    dcID: mainDcId,
    id: currentUserId,
    test: isTest,
    serverConfigScope,
  }));
  localStorage.setItem('dc', String(mainDcId));
  Object.keys(keys).map(Number).forEach((dcId) => {
    localStorage.setItem(`dc${dcId}_auth_key`, JSON.stringify(keys[dcId]));
  });
}

export function clearStoredSession(slot?: number) {
  if (!slot) {
    clearStoredLegacySession();
  }

  localStorage.removeItem(`${SESSION_ACCOUNT_PREFIX}${slot || 1}`);
}

function clearStoredLegacySession() {
  [
    SESSION_LEGACY_USER_KEY,
    'dc',
    ...DC_IDS.map((dcId) => `dc${dcId}_auth_key`),
    ...DC_IDS.map((dcId) => `dc${dcId}_hash`),
    ...DC_IDS.map((dcId) => `dc${dcId}_server_salt`),
  ].forEach((key) => {
    localStorage.removeItem(key);
  });
}

export function loadStoredSession(serverConfigScope = readCurrentServerConfigScope()): ApiSessionData | undefined {
  if (!hasStoredSession(serverConfigScope)) {
    return undefined;
  }

  const slotData = loadSlotSession(ACCOUNT_SLOT, serverConfigScope);

  if (!slotData) {
    if (ACCOUNT_SLOT) return undefined;
    return loadStoredLegacySession(serverConfigScope);
  }

  const sessionData: ApiSessionData = {
    mainDcId: slotData.dcId,
    keys: DC_IDS.reduce((acc, dcId) => {
      const key = slotData[`dc${dcId}_auth_key` as const];
      if (key) {
        acc[dcId] = key;
      }
      return acc;
    }, {} as Record<number, string>),
    isTest: slotData.isTest || undefined,
    serverConfigScope: slotData.serverConfigScope,
  };

  return sessionData;
}

function loadStoredLegacySession(serverConfigScope = readCurrentServerConfigScope()): ApiSessionData | undefined {
  if (!hasStoredSession(serverConfigScope)) {
    return undefined;
  }

  const userAuth = JSON.parse(localStorage.getItem(SESSION_LEGACY_USER_KEY) || 'null');
  if (!userAuth) {
    return undefined;
  }
  const mainDcId = Number(userAuth.dcID);
  const isTest = userAuth.test;
  const keys: Record<number, string> = {};

  DC_IDS.forEach((dcId) => {
    try {
      const key = localStorage.getItem(`dc${dcId}_auth_key`);
      if (key) {
        keys[dcId] = JSON.parse(key);
      }
    } catch (err) {
      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.warn('Failed to load stored session', err);
      }
      // Do nothing.
    }
  });

  if (!Object.keys(keys).length) return undefined;

  return {
    mainDcId,
    keys,
    isTest,
    serverConfigScope: userAuth.serverConfigScope,
  };
}

export function loadSlotSession(
  slot: number | undefined,
  serverConfigScope = readCurrentServerConfigScope(),
): SharedSessionData | undefined {
  try {
    const data = JSON.parse(localStorage.getItem(`${SESSION_ACCOUNT_PREFIX}${slot || 1}`) || '{}') as SharedSessionData;
    if (!data.dcId || !isServerConfigScopeCompatible(data.serverConfigScope, serverConfigScope)) {
      return undefined;
    }
    return data;
  } catch (e) {
    return undefined;
  }
}

export function updateSessionUserId(currentUserId: string) {
  const slotData = loadSlotSession(ACCOUNT_SLOT);
  if (!slotData) return;
  storeAccountData(ACCOUNT_SLOT, { userId: currentUserId });
}

export function importTestSession() {
  const sessionJson = process.env.TEST_SESSION!;
  try {
    const sessionData = JSON.parse(sessionJson) as ApiSessionData & { userId: string };
    storeLegacySession(sessionData, sessionData.userId);
  } catch (err) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('Failed to load test session', err);
    }
  }
}

export function checkSessionLocked() {
  return localStorage.getItem(IS_SCREEN_LOCKED_CACHE_KEY) === 'true';
}
