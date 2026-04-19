import type { ChangeEvent } from 'react';
import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';
import {
  getActions, getGlobal, withGlobal,
} from '../../../global';

import type { ApiServerProfileId } from '../../../api/types';

import { DEBUG_LOG_FILENAME } from '../../../config';
import { cacheSharedState } from '../../../global/cache';
import { selectSharedSettings } from '../../../global/selectors/sharedState';
import {
  IS_SNAP_EFFECT_SUPPORTED,
  IS_WAVE_TRANSFORM_SUPPORTED,
} from '../../../util/browser/windowEnvironment';
import { getDebugLogs } from '../../../util/debugConsole';
import download from '../../../util/download';
import {
  buildServerConfigScope,
  writeCurrentServerConfigScope,
} from '../../../util/mtprotoServer';
import { getAccountSlotUrl } from '../../../util/multiaccount';
import { LOCAL_TGS_URLS } from '../../common/helpers/animatedAssets';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLastCallback from '../../../hooks/useLastCallback';
import useMultiaccountInfo from '../../../hooks/useMultiaccountInfo';
import useOldLang from '../../../hooks/useOldLang';

import AnimatedIconWithPreview from '../../common/AnimatedIconWithPreview';
import { animateSnap } from '../../main/visualEffects/SnapEffectContainer';
import Checkbox from '../../ui/Checkbox';
import InputText from '../../ui/InputText';
import ListItem from '../../ui/ListItem';
import Select from '../../ui/Select';

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

type StateProps = {
  shouldForceHttpTransport?: boolean;
  shouldAllowHttpTransport?: boolean;
  shouldCollectDebugLogs?: boolean;
  shouldDebugExportedSenders?: boolean;
  mtprotoServerProfile: ApiServerProfileId;
  mtprotoCustomServerHostPattern?: string;
  mtprotoCustomServerPort?: number;
  mtprotoCustomServerDefaultDcId?: number;
};

const DEFAULT_CUSTOM_HOST_PATTERN = 'localhost';
const DEFAULT_CUSTOM_PORT = '443';
const DEFAULT_CUSTOM_DC_ID = '1';

const SettingsExperimental = ({
  isActive,
  shouldForceHttpTransport,
  shouldAllowHttpTransport,
  shouldCollectDebugLogs,
  shouldDebugExportedSenders,
  mtprotoServerProfile,
  mtprotoCustomServerHostPattern,
  mtprotoCustomServerPort,
  mtprotoCustomServerDefaultDcId,
  onReset,
}: OwnProps & StateProps) => {
  const {
    requestConfetti, setSharedSettingOption, requestWave, showNotification,
  } = getActions();

  const snapButtonRef = useRef<HTMLDivElement>();
  const [isSnapButtonAnimating, setIsSnapButtonAnimating] = useState(false);
  const [serverProfile, setServerProfile] = useState<ApiServerProfileId>(mtprotoServerProfile);
  const [customHostPattern, setCustomHostPattern] = useState(
    mtprotoCustomServerHostPattern || DEFAULT_CUSTOM_HOST_PATTERN,
  );
  const [customPort, setCustomPort] = useState(String(mtprotoCustomServerPort || DEFAULT_CUSTOM_PORT));
  const [customDefaultDcId, setCustomDefaultDcId] = useState(String(
    mtprotoCustomServerDefaultDcId || DEFAULT_CUSTOM_DC_ID,
  ));

  const lang = useOldLang();

  const accounts = useMultiaccountInfo();

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  useEffect(() => {
    setServerProfile(mtprotoServerProfile);
    setCustomHostPattern(mtprotoCustomServerHostPattern || DEFAULT_CUSTOM_HOST_PATTERN);
    setCustomPort(String(mtprotoCustomServerPort || DEFAULT_CUSTOM_PORT));
    setCustomDefaultDcId(String(mtprotoCustomServerDefaultDcId || DEFAULT_CUSTOM_DC_ID));
  }, [
    mtprotoServerProfile,
    mtprotoCustomServerHostPattern,
    mtprotoCustomServerPort,
    mtprotoCustomServerDefaultDcId,
  ]);

  const handleDownloadLog = useLastCallback(() => {
    const file = new File([getDebugLogs()], DEBUG_LOG_FILENAME, { type: 'text/plain' });
    const url = URL.createObjectURL(file);
    download(url, DEBUG_LOG_FILENAME);
  });

  const handleRequestWave = useLastCallback((e: React.MouseEvent<HTMLElement, MouseEvent>) => {
    requestWave({ startX: e.clientX, startY: e.clientY });
  });

  const handleRequestConfetti = useLastCallback(() => {
    requestConfetti({ withStars: true });
  });

  const handleSnap = useLastCallback(() => {
    const button = snapButtonRef.current;
    if (!button) return;

    if (animateSnap(button)) {
      setIsSnapButtonAnimating(true);
      // Manual reset for debug
      setTimeout(() => {
        setIsSnapButtonAnimating(false);
      }, 1500);
    }
  });

  const handleServerProfileChange = useLastCallback((e: ChangeEvent<HTMLSelectElement>) => {
    setServerProfile(e.currentTarget.value as ApiServerProfileId);
  });

  const handleCustomHostPatternChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setCustomHostPattern(e.currentTarget.value);
  });

  const handleCustomPortChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setCustomPort(e.currentTarget.value.replace(/[^\d]/g, '').slice(0, 5));
  });

  const handleCustomDefaultDcIdChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setCustomDefaultDcId(e.currentTarget.value.replace(/[^\d]/g, '').slice(0, 1));
  });

  const handleReload = useLastCallback(() => {
    window.location.reload();
  });

  const handleApplyServerProfile = useLastCallback(() => {
    const normalizedHostPattern = customHostPattern.trim();
    const parsedPort = Number(customPort);
    const parsedDefaultDcId = Number(customDefaultDcId);

    if (serverProfile === 'custom') {
      if (!normalizedHostPattern) {
        showNotification({ message: 'Enter a DC host pattern before saving the custom server profile.' });
        return;
      }

      if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        showNotification({ message: 'Custom MTProto port must be between 1 and 65535.' });
        return;
      }

      if (![1, 2, 3, 4, 5].includes(parsedDefaultDcId)) {
        showNotification({ message: 'Custom default DC must be between 1 and 5.' });
        return;
      }
    }

    const currentSettings = selectSharedSettings(getGlobal());
    const nextSettings = {
      ...currentSettings,
      mtprotoServerProfile: serverProfile,
      mtprotoCustomServerHostPattern: normalizedHostPattern || DEFAULT_CUSTOM_HOST_PATTERN,
      mtprotoCustomServerPort: parsedPort || Number(DEFAULT_CUSTOM_PORT),
      mtprotoCustomServerDefaultDcId: parsedDefaultDcId || Number(DEFAULT_CUSTOM_DC_ID),
    };

    setSharedSettingOption(nextSettings);
    writeCurrentServerConfigScope(buildServerConfigScope(nextSettings));
    void cacheSharedState({
      settings: nextSettings,
    });

    showNotification({
      message: serverProfile === 'custom'
        ? 'Custom MTProto profile saved. Reload the app to reconnect to the new backend.'
        : 'Official Telegram MTProto profile restored. Reload the app to reconnect.',
    });
  });

  const newAccountUrl = useMemo(() => {
    if (!Object.values(accounts).length) {
      return undefined;
    }

    let freeIndex = 1;
    while (accounts[freeIndex]) {
      freeIndex += 1;
    }

    return getAccountSlotUrl(freeIndex, true, true);
  }, [accounts]);

  const isCustomProfile = serverProfile === 'custom';
  const isServerProfileDirty = useMemo(() => {
    return serverProfile !== mtprotoServerProfile
      || customHostPattern !== (mtprotoCustomServerHostPattern || DEFAULT_CUSTOM_HOST_PATTERN)
      || customPort !== String(mtprotoCustomServerPort || DEFAULT_CUSTOM_PORT)
      || customDefaultDcId !== String(mtprotoCustomServerDefaultDcId || DEFAULT_CUSTOM_DC_ID);
  }, [
    customDefaultDcId,
    customHostPattern,
    customPort,
    mtprotoCustomServerDefaultDcId,
    mtprotoCustomServerHostPattern,
    mtprotoCustomServerPort,
    mtprotoServerProfile,
    serverProfile,
  ]);

  return (
    <div className="settings-content custom-scroll">
      <div className="settings-content-header no-border">
        <AnimatedIconWithPreview
          tgsUrl={LOCAL_TGS_URLS.Experimental}
          size={200}
          className="experimental-duck"
          nonInteractive
          noLoop={false}
        />
        <p className="settings-item-description pt-3" dir="auto">{lang('lng_settings_experimental_about')}</p>
      </div>
      <div className="settings-item">
        <ListItem
          href={newAccountUrl}
          icon="add-user"
        >
          <div className="title">Login on Test Server</div>
        </ListItem>
      </div>
      <div className="settings-item">
        <p className="settings-item-description" dir="auto">
          MTProto server profile.
          Custom backends still need Telegram Web compatible transports and endpoints:
          <code> /apiws </code>
          and
          <code> /apiw1</code>
          .
          Use
          <code>
            {' '}
            {`dc{dcId}.example.com`}
            {' '}
          </code>
          or
          <code> localhost </code>
          for a single-host setup.
          <code>
            {' '}
            {`{downloadSuffix}`}
            {' '}
          </code>
          is optional.
        </p>
        <Select
          id="mtproto-server-profile"
          label="MTProto Server"
          hasArrow
          value={serverProfile}
          onChange={handleServerProfileChange}
        >
          <option value="telegram-official">Official Telegram</option>
          <option value="custom">Custom self-host</option>
        </Select>
        <InputText
          value={customHostPattern}
          label="DC Host Pattern"
          onChange={handleCustomHostPatternChange}
        />
        <InputText
          value={customPort}
          label="Port"
          inputMode="numeric"
          onChange={handleCustomPortChange}
        />
        <InputText
          value={customDefaultDcId}
          label="Default DC"
          inputMode="numeric"
          onChange={handleCustomDefaultDcIdChange}
        />
        {!isCustomProfile && (
          <p className="settings-item-description" dir="auto">
            Official mode ignores the custom fields above, but keeps them saved so you can switch back quickly.
          </p>
        )}
        <ListItem
          onClick={handleApplyServerProfile}
          disabled={!isServerProfileDirty}
        >
          <div className="title">Save MTProto Server Profile</div>
        </ListItem>
        <ListItem
          onClick={handleReload}
          icon="reload"
        >
          <div className="title">Reload App</div>
        </ListItem>
      </div>
      <div className="settings-item">
        <ListItem
          onClick={handleRequestConfetti}
          icon="animations"
        >
          <div className="title">Launch some confetti!</div>
        </ListItem>
        <ListItem
          onClick={handleRequestWave}
          icon="story-expired"
          disabled={!IS_WAVE_TRANSFORM_SUPPORTED}
        >
          <div className="title">Start wave</div>
        </ListItem>
        <ListItem
          ref={snapButtonRef}
          onClick={handleSnap}
          icon="spoiler"
          disabled={!IS_SNAP_EFFECT_SUPPORTED}
          style={isSnapButtonAnimating ? 'visibility: hidden' : ''}
        >
          <div className="title">Vaporize this button</div>
        </ListItem>
      </div>
      <div className="settings-item">
        <Checkbox
          label="Allow HTTP Transport"
          checked={Boolean(shouldAllowHttpTransport)}

          onCheck={() => setSharedSettingOption({ shouldAllowHttpTransport: !shouldAllowHttpTransport })}
        />

        <Checkbox
          label="Force HTTP Transport"
          disabled={!shouldAllowHttpTransport}
          checked={Boolean(shouldForceHttpTransport)}

          onCheck={() => setSharedSettingOption({ shouldForceHttpTransport: !shouldForceHttpTransport })}
        />
      </div>
      <div className="settings-item">
        <Checkbox
          label={lang('DebugMenuEnableLogs')}
          checked={Boolean(shouldCollectDebugLogs)}

          onCheck={() => setSharedSettingOption({ shouldCollectDebugLogs: !shouldCollectDebugLogs })}
        />

        <Checkbox
          label="Enable exported senders debug"
          checked={Boolean(shouldDebugExportedSenders)}

          onCheck={() => setSharedSettingOption({ shouldDebugExportedSenders: !shouldDebugExportedSenders })}
        />

        <ListItem
          onClick={handleDownloadLog}
          icon="bug"
        >
          <div className="title">Download log</div>
        </ListItem>
      </div>
    </div>
  );
};

export default memo(withGlobal(
  (global): Complete<StateProps> => {
    const {
      shouldForceHttpTransport,
      shouldAllowHttpTransport,
      shouldCollectDebugLogs,
      shouldDebugExportedSenders,
      mtprotoServerProfile,
      mtprotoCustomServerHostPattern,
      mtprotoCustomServerPort,
      mtprotoCustomServerDefaultDcId,
    } = selectSharedSettings(global);

    return {
      shouldForceHttpTransport,
      shouldAllowHttpTransport,
      shouldCollectDebugLogs,
      shouldDebugExportedSenders,
      mtprotoServerProfile,
      mtprotoCustomServerHostPattern,
      mtprotoCustomServerPort,
      mtprotoCustomServerDefaultDcId,
    };
  },
)(SettingsExperimental));
