import type { ApiServerConfig, ApiServerProfileId } from '../api/types';
import type { SharedSettings } from '../global/types';
import type { DcId } from '../types';

import { DC_IDS } from '../config';

export const OFFICIAL_SERVER_PROFILE_ID = 'telegram-official' as const;
export const CUSTOM_SERVER_PROFILE_ID = 'custom' as const;
export const SERVER_CONFIG_SCOPE_STORAGE_KEY = 'tt-mtproto-server-scope';

const DEFAULT_OFFICIAL_HOST_PATTERN = process.env.TELEGRAM_CUSTOM_SERVER || 'localhost';
const DEFAULT_OFFICIAL_PORT = Number(process.env.TELEGRAM_CUSTOM_PORT) || 8080;
const DEFAULT_OFFICIAL_DC_ID: DcId = 1;
const DEFAULT_CUSTOM_HOST_PATTERN = process.env.TELEGRAM_CUSTOM_SERVER || 'localhost';
const DEFAULT_CUSTOM_PORT = Number(process.env.TELEGRAM_CUSTOM_PORT) || 8080;
const DEFAULT_CUSTOM_DC_ID: DcId = 1;

type ServerSettingsShape = Pick<SharedSettings, (
  'mtprotoServerProfile'
  | 'mtprotoCustomServerHostPattern'
  | 'mtprotoCustomServerPort'
  | 'mtprotoCustomServerDefaultDcId'
)>;

function isValidDcId(dcId?: number): dcId is DcId {
  return DC_IDS.includes(dcId as DcId);
}

export function normalizeServerProfileId(profileId?: string): ApiServerProfileId {
  if (profileId === CUSTOM_SERVER_PROFILE_ID) return CUSTOM_SERVER_PROFILE_ID;
  return CUSTOM_SERVER_PROFILE_ID;
}

export function normalizeServerHostPattern(
  hostPattern: string | undefined,
  profileId: ApiServerProfileId,
) {
  if (process.env.TELEGRAM_CUSTOM_SERVER) return process.env.TELEGRAM_CUSTOM_SERVER;
  // When accessed via a real domain (not localhost), use the same host so WS proxy works
  if (typeof window !== 'undefined' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    return window.location.hostname;
  }
  return 'localhost';
}

export function normalizeServerPort(
  port: number | undefined,
  profileId: ApiServerProfileId,
) {
  if (process.env.TELEGRAM_CUSTOM_PORT) return Number(process.env.TELEGRAM_CUSTOM_PORT);
  // When accessed via HTTPS (port 443), use 443 so GramJS builds wss:// URL through the proxy
  if (typeof window !== 'undefined' && window.location.protocol === 'https:') {
    return 443;
  }
  // When accessed via a non-default port over HTTP, use same port (webpack proxy handles /apiws)
  if (typeof window !== 'undefined' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    return Number(window.location.port) || 80;
  }
  return 8080;
}

export function normalizeServerDefaultDcId(
  dcId: number | undefined,
  profileId: ApiServerProfileId,
) {
  if (isValidDcId(dcId)) {
    return dcId;
  }

  return profileId === CUSTOM_SERVER_PROFILE_ID ? DEFAULT_CUSTOM_DC_ID : DEFAULT_OFFICIAL_DC_ID;
}

export function buildApiServerConfig(
  settings?: Partial<ServerSettingsShape>,
): ApiServerConfig {
  const profileId = normalizeServerProfileId(settings?.mtprotoServerProfile);

  return {
    profileId,
    defaultDcId: normalizeServerDefaultDcId(settings?.mtprotoCustomServerDefaultDcId, profileId),
    hostPattern: normalizeServerHostPattern(settings?.mtprotoCustomServerHostPattern, profileId),
    port: normalizeServerPort(settings?.mtprotoCustomServerPort, profileId),
  };
}

export function buildServerConfigScope(
  settings?: Partial<ServerSettingsShape>,
) {
  const {
    profileId,
    defaultDcId,
    hostPattern,
    port,
  } = buildApiServerConfig(settings);

  return [profileId, defaultDcId, port, hostPattern].join('|');
}

export function resolveDcAddress(
  serverConfig: ApiServerConfig | undefined,
  dcId: number,
  downloadDC = false,
) {
  const activeServerConfig = serverConfig || buildApiServerConfig();
  const host = activeServerConfig.hostPattern
    .replaceAll('{dcId}', String(dcId))
    .replaceAll('{downloadSuffix}', downloadDC ? '-1' : '');

  return {
    id: dcId,
    ipAddress: host,
    port: activeServerConfig.port,
  };
}

export function readCurrentServerConfigScope() {
  if (typeof window === 'undefined') {
    return buildServerConfigScope();
  }

  return localStorage.getItem(SERVER_CONFIG_SCOPE_STORAGE_KEY) || buildServerConfigScope();
}

export function writeCurrentServerConfigScope(
  serverScopeOrSettings: string | Partial<ServerSettingsShape>,
) {
  if (typeof window === 'undefined') {
    return;
  }

  const scope = typeof serverScopeOrSettings === 'string'
    ? serverScopeOrSettings
    : buildServerConfigScope(serverScopeOrSettings);

  localStorage.setItem(SERVER_CONFIG_SCOPE_STORAGE_KEY, scope);
}

export function isServerConfigScopeCompatible(
  storedScope: string | undefined,
  currentScope = readCurrentServerConfigScope(),
) {
  if (storedScope) {
    return storedScope === currentScope;
  }

  return currentScope === buildServerConfigScope();
}
