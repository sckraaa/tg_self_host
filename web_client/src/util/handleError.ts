import { DEBUG, DEBUG_ALERT_MSG } from '../config';
import { isCurrentTabMaster } from './establishMultitabRole';
import { throttle } from './schedulers';

let showError = true;
let error: unknown;

window.addEventListener('error', handleErrorEvent);
window.addEventListener('unhandledrejection', handleErrorEvent);

if (DEBUG) {
  window.addEventListener('focus', () => {
    if (!isCurrentTabMaster()) {
      return;
    }
    showError = true;
    if (error) {
      window.alert(getErrorMessage(error));
      error = undefined;
    }
  });
  window.addEventListener('blur', () => {
    if (!isCurrentTabMaster()) {
      return;
    }
    showError = false;
  });
}

const throttleError = throttle((err: unknown) => {
  if (showError) {
    window.alert(getErrorMessage(err));
  } else {
    error = err;
  }
}, 1500);

export function handleError(err: unknown) {
  // eslint-disable-next-line no-console
  console.error(err ?? 'Unknown error');
  if (DEBUG) {
    throttleError(err);
  }
}

function handleErrorEvent(e: ErrorEvent | PromiseRejectionEvent) {
  // Ignore resource load errors from <img>/<video>/<audio> elements (e.g. stale blob URLs after page reload).
  // These arrive as plain Event (not ErrorEvent), so check before the instanceof guard.
  const target = 'target' in e ? (e as Event).target : undefined;
  if (target instanceof HTMLImageElement || target instanceof HTMLVideoElement
    || target instanceof HTMLAudioElement) {
    return;
  }

  if (e instanceof ErrorEvent) {
    // https://stackoverflow.com/questions/49384120/resizeobserver-loop-limit-exceeded
    if (e.message === 'ResizeObserver loop limit exceeded') {
      return;
    }

    // Flood wait errors
    if (e.message.includes('A wait of')) {
      return;
    }
  }

  e.preventDefault();
  handleError(e instanceof ErrorEvent ? (e.error || e.message) : e.reason);
}

function getErrorMessage(err: unknown) {
  const message = getReadableError(err);
  const stack = err instanceof Error ? err.stack : undefined;

  return `${DEBUG_ALERT_MSG}\n\n${message}\n${stack || ''}`;
}

function getReadableError(err: unknown) {
  if (err instanceof Error) {
    return err.message;
  }

  if (typeof err === 'string') {
    return err;
  }

  if (err === undefined) {
    return 'Unknown error';
  }

  try {
    const serialized = JSON.stringify(err);

    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Ignore and fall back to a generic object label below.
  }

  return Object.prototype.toString.call(err);
}
