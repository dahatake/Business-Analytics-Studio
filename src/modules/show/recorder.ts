/* FR-081: save the short video to a file with the Screen Capture API + MediaRecorder. */

/** Preferred container/codec order (first supported wins). */
export const RECORD_MIME_CANDIDATES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'] as const;

/** First MIME type the recorder supports, or null when none is (e.g. no MediaRecorder at all). */
export function pickRecordingMime(isTypeSupported: ((mime: string) => boolean) | undefined): string | null {
  if (!isTypeSupported) return null;
  for (const mime of RECORD_MIME_CANDIDATES) {
    try {
      if (isTypeSupported(mime)) return mime;
    } catch {
      // Some engines throw on unknown codec strings; treat as unsupported.
    }
  }
  return null;
}

/** A video-only codec string cannot carry the tab's audio track; add Opus when the engine supports it. */
export function withAudioCodec(mime: string, hasAudio: boolean, isTypeSupported: (mime: string) => boolean): string {
  if (!hasAudio || !/codecs=vp[89]$/.test(mime)) return mime;
  const withOpus = `${mime},opus`;
  try {
    return isTypeSupported(withOpus) ? withOpus : mime;
  } catch {
    return mime;
  }
}

export function extensionForMime(mime: string): 'webm' | 'mp4' {
  return mime.toLowerCase().startsWith('video/mp4') ? 'mp4' : 'webm';
}

/** Characters that are unsafe in file names on Windows/macOS/Linux become '-'. */
export function fileSafe(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[\\/:*?"<>|()（）\u0000-\u001f]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned || 'company';
}

const pad = (n: number) => String(n).padStart(2, '0');

export function dateStamp(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/** `<company>-short-video-YYYYMMDD.<ext>` */
export function videoFileName(company: string, date: Date, mime: string): string {
  return `${fileSafe(company)}-short-video-${dateStamp(date)}.${extensionForMime(mime)}`;
}

/* ---------- recorder state machine ---------- */

export type RecordErrorReason = 'unsupported' | 'denied' | 'failed';

export type RecordState =
  | { status: 'idle' }
  | { status: 'confirm' }
  | { status: 'requesting' }
  | { status: 'recording' }
  | { status: 'saving' }
  | { status: 'saved'; fileName: string }
  | { status: 'error'; reason: RecordErrorReason };

export type RecordEvent =
  | { type: 'open' }
  | { type: 'cancel' }
  | { type: 'confirm' }
  | { type: 'granted' }
  | { type: 'fail'; reason: RecordErrorReason }
  | { type: 'stop' }
  | { type: 'saved'; fileName: string }
  | { type: 'dismiss' };

export const RECORD_IDLE: RecordState = { status: 'idle' };

/** Pure transition function; events that do not apply to the current state are ignored. */
export function recordReducer(state: RecordState, event: RecordEvent): RecordState {
  switch (event.type) {
    case 'open':
      return state.status === 'idle' || state.status === 'saved' || state.status === 'error' ? { status: 'confirm' } : state;
    case 'cancel':
      return state.status === 'confirm' ? RECORD_IDLE : state;
    case 'confirm':
      return state.status === 'confirm' ? { status: 'requesting' } : state;
    case 'granted':
      return state.status === 'requesting' ? { status: 'recording' } : state;
    case 'fail':
      return state.status === 'idle' || state.status === 'confirm' || state.status === 'requesting' || state.status === 'recording' || state.status === 'saving'
        ? { status: 'error', reason: event.reason }
        : state;
    case 'stop':
      return state.status === 'recording' ? { status: 'saving' } : state;
    case 'saved':
      return state.status === 'saving' ? { status: 'saved', fileName: event.fileName } : state;
    case 'dismiss':
      return state.status === 'error' || state.status === 'saved' ? RECORD_IDLE : state;
  }
}

/** Whether the confirm/error dialog is shown over the player. */
export const recordDialogOpen = (s: RecordState) => s.status === 'confirm' || s.status === 'requesting' || s.status === 'error';

/** Classify a getDisplayMedia rejection. */
export function captureErrorReason(err: unknown): RecordErrorReason {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'NotAllowedError' || name === 'AbortError' || name === 'SecurityError') return 'denied';
  if (name === 'NotSupportedError' || name === 'TypeError') return 'unsupported';
  return 'failed';
}

/* ---------- browser glue ---------- */

export interface CaptureEnv {
  getDisplayMedia?: (options: DisplayMediaStreamOptions) => Promise<MediaStream>;
  isTypeSupported?: (mime: string) => boolean;
}

export function browserCaptureEnv(): CaptureEnv {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  const MR = typeof MediaRecorder !== 'undefined' ? MediaRecorder : undefined;
  return {
    getDisplayMedia: md && typeof md.getDisplayMedia === 'function' ? md.getDisplayMedia.bind(md) : undefined,
    isTypeSupported: MR && typeof MR.isTypeSupported === 'function' ? MR.isTypeSupported.bind(MR) : undefined,
  };
}

export const captureSupported = (env: CaptureEnv) => Boolean(env.getDisplayMedia) && pickRecordingMime(env.isTypeSupported) !== null;

/** Options for "this tab" capture; the extra members are Chromium hints not yet in the DOM lib types. */
interface TabCaptureOptions extends DisplayMediaStreamOptions {
  preferCurrentTab: boolean;
  selfBrowserSurface: 'include' | 'exclude';
}

export const TAB_CAPTURE_OPTIONS: TabCaptureOptions = {
  video: { displaySurface: 'browser' } as MediaTrackConstraints,
  audio: true,
  preferCurrentTab: true,
  selfBrowserSurface: 'include',
};

export function stopTracks(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((t) => t.stop());
}

/** Starts the browser download of a blob. */
export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export interface ActiveRecording {
  /** Stops recording; the file is assembled and `onDone` is called once. */
  stop: () => void;
}

/**
 * Records `stream` with MediaRecorder. All tracks are stopped when recording ends,
 * including when the user ends sharing from the browser UI.
 */
export function recordStream(
  stream: MediaStream,
  mime: string,
  onDone: (result: { ok: true; blob: Blob; mime: string } | { ok: false }) => void,
): ActiveRecording {
  const chunks: Blob[] = [];
  let finished = false;
  const finish = (result: Parameters<typeof onDone>[0]) => {
    if (finished) return;
    finished = true;
    stopTracks(stream);
    onDone(result);
  };
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType: mime });
  } catch {
    finish({ ok: false });
    return { stop: () => undefined };
  }
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = () => {
    const type = recorder.mimeType || mime;
    finish(chunks.length > 0 ? { ok: true, blob: new Blob(chunks, { type }), mime: type } : { ok: false });
  };
  recorder.onerror = () => {
    if (recorder.state !== 'inactive') recorder.stop();
    else finish({ ok: false });
  };
  const stop = () => {
    if (recorder.state !== 'inactive') recorder.stop();
  };
  stream.getVideoTracks().forEach((t) => t.addEventListener('ended', stop));
  try {
    recorder.start(1000);
  } catch {
    finish({ ok: false });
  }
  return { stop };
}

/** E2E hook: `window.__basShow.recordSeconds` shortens the recording. */
export function recordLimitMs(defaultMs: number): number {
  const hook = (globalThis as { __basShow?: { recordSeconds?: unknown } }).__basShow;
  const s = hook?.recordSeconds;
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s * 1000 : defaultMs;
}
