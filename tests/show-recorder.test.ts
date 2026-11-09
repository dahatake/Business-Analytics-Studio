import { describe, expect, it, vi } from 'vitest';
import {
  captureErrorReason, captureSupported, dateStamp, extensionForMime, fileSafe, pickRecordingMime, RECORD_IDLE, RECORD_MIME_CANDIDATES,
  recordDialogOpen, recordLimitMs, recordReducer, recordStream, TAB_CAPTURE_OPTIONS, videoFileName, withAudioCodec, type RecordEvent, type RecordState,
} from '../src/modules/show/recorder.ts';

const only = (...ok: string[]) => (m: string) => ok.includes(m);

describe('FR-081 recording MIME selection', () => {
  it('keeps the required preference order', () => {
    expect(RECORD_MIME_CANDIDATES).toEqual(['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']);
  });

  it('picks the first supported type', () => {
    expect(pickRecordingMime(only(...RECORD_MIME_CANDIDATES))).toBe('video/webm;codecs=vp9');
    expect(pickRecordingMime(only('video/webm;codecs=vp8', 'video/webm'))).toBe('video/webm;codecs=vp8');
    expect(pickRecordingMime(only('video/webm'))).toBe('video/webm');
    expect(pickRecordingMime(only('video/mp4'))).toBe('video/mp4');
  });

  it('returns null when nothing (or no MediaRecorder) is available, and survives throwing checks', () => {
    expect(pickRecordingMime(only())).toBeNull();
    expect(pickRecordingMime(undefined)).toBeNull();
    expect(pickRecordingMime((m) => { if (m.includes('codecs')) throw new Error('bad'); return m === 'video/webm'; })).toBe('video/webm');
  });

  it('adds Opus for a video-only codec string only when there is audio and it is supported', () => {
    const all = only('video/webm;codecs=vp9', 'video/webm;codecs=vp9,opus');
    expect(withAudioCodec('video/webm;codecs=vp9', true, all)).toBe('video/webm;codecs=vp9,opus');
    expect(withAudioCodec('video/webm;codecs=vp9', false, all)).toBe('video/webm;codecs=vp9');
    expect(withAudioCodec('video/webm;codecs=vp8', true, all)).toBe('video/webm;codecs=vp8');
    expect(withAudioCodec('video/webm', true, all)).toBe('video/webm');
    expect(withAudioCodec('video/mp4', true, all)).toBe('video/mp4');
  });

  it('detects support only when both getDisplayMedia and a recordable type exist', () => {
    const gdm = vi.fn();
    expect(captureSupported({ getDisplayMedia: gdm, isTypeSupported: only('video/webm') })).toBe(true);
    expect(captureSupported({ getDisplayMedia: undefined, isTypeSupported: only('video/webm') })).toBe(false);
    expect(captureSupported({ getDisplayMedia: gdm, isTypeSupported: undefined })).toBe(false);
    expect(captureSupported({ getDisplayMedia: gdm, isTypeSupported: only('video/ogg') })).toBe(false);
  });

  it('asks for this tab with audio', () => {
    expect(TAB_CAPTURE_OPTIONS).toMatchObject({ video: { displaySurface: 'browser' }, audio: true, preferCurrentTab: true, selfBrowserSurface: 'include' });
  });
});

describe('FR-081 file name', () => {
  const date = new Date(2026, 10, 9, 13, 5);

  it('uses <company>-short-video-YYYYMMDD with the extension of the MIME type', () => {
    expect(dateStamp(date)).toBe('20261109');
    expect(dateStamp(new Date(2027, 0, 3))).toBe('20270103');
    expect(videoFileName('Aozora Precision (fictional)', date, 'video/webm;codecs=vp9')).toBe('Aozora-Precision-fictional-short-video-20261109.webm');
    expect(videoFileName('Aozora', date, 'video/webm;codecs=vp8,opus')).toBe('Aozora-short-video-20261109.webm');
    expect(videoFileName('Aozora', date, 'video/mp4')).toBe('Aozora-short-video-20261109.mp4');
    expect(videoFileName('青空精機（架空）', date, 'video/webm')).toBe('青空精機-架空-short-video-20261109.webm');
  });

  it('maps MIME types to extensions', () => {
    expect(extensionForMime('video/mp4;codecs=avc1')).toBe('mp4');
    expect(extensionForMime('VIDEO/MP4')).toBe('mp4');
    expect(extensionForMime('video/webm')).toBe('webm');
    expect(extensionForMime('video/x-matroska')).toBe('webm');
  });

  it('removes characters that are unsafe in file names', () => {
    expect(fileSafe('A/B\\C:D*E?F"G<H>I|J')).toBe('A-B-C-D-E-F-G-H-I-J');
    expect(fileSafe('  ..hidden..  ')).toBe('hidden');
    expect(fileSafe('???')).toBe('company');
    expect(fileSafe('')).toBe('company');
  });
});

describe('FR-081 recorder state machine', () => {
  const run = (events: RecordEvent[], from: RecordState = RECORD_IDLE) => events.reduce(recordReducer, from);

  it('goes through confirm → requesting → recording → saving → saved → idle', () => {
    const steps: RecordEvent[] = [{ type: 'open' }, { type: 'confirm' }, { type: 'granted' }, { type: 'stop' }, { type: 'saved', fileName: 'a.webm' }];
    const seen: string[] = [];
    let s = RECORD_IDLE;
    for (const e of steps) { s = recordReducer(s, e); seen.push(s.status); }
    expect(seen).toEqual(['confirm', 'requesting', 'recording', 'saving', 'saved']);
    expect(s).toEqual({ status: 'saved', fileName: 'a.webm' });
    expect(recordReducer(s, { type: 'dismiss' })).toEqual(RECORD_IDLE);
    expect(recordReducer(s, { type: 'open' })).toEqual({ status: 'confirm' });
  });

  it('cancel from the dialog records nothing', () => {
    expect(run([{ type: 'open' }, { type: 'cancel' }])).toEqual(RECORD_IDLE);
  });

  it('a denied or unsupported capture ends in an error that can be dismissed', () => {
    const denied = run([{ type: 'open' }, { type: 'confirm' }, { type: 'fail', reason: 'denied' }]);
    expect(denied).toEqual({ status: 'error', reason: 'denied' });
    expect(recordDialogOpen(denied)).toBe(true);
    expect(recordReducer(denied, { type: 'dismiss' })).toEqual(RECORD_IDLE);
    expect(run([{ type: 'fail', reason: 'unsupported' }])).toEqual({ status: 'error', reason: 'unsupported' });
    expect(run([{ type: 'open' }, { type: 'confirm' }, { type: 'granted' }, { type: 'stop' }, { type: 'fail', reason: 'failed' }])).toEqual({ status: 'error', reason: 'failed' });
  });

  it('ignores events that do not apply (double stop, saved without stop, granted without request)', () => {
    expect(run([{ type: 'stop' }])).toEqual(RECORD_IDLE);
    expect(run([{ type: 'granted' }])).toEqual(RECORD_IDLE);
    expect(run([{ type: 'saved', fileName: 'x' }])).toEqual(RECORD_IDLE);
    expect(run([{ type: 'open' }, { type: 'confirm' }, { type: 'granted' }, { type: 'open' }])).toEqual({ status: 'recording' });
    expect(run([{ type: 'open' }, { type: 'confirm' }, { type: 'granted' }, { type: 'stop' }, { type: 'stop' }])).toEqual({ status: 'saving' });
    expect(run([{ type: 'open' }, { type: 'confirm' }, { type: 'cancel' }])).toEqual({ status: 'requesting' });
  });

  it('shows the dialog only while confirming, requesting or reporting an error', () => {
    expect(recordDialogOpen({ status: 'confirm' })).toBe(true);
    expect(recordDialogOpen({ status: 'requesting' })).toBe(true);
    expect(recordDialogOpen({ status: 'recording' })).toBe(false);
    expect(recordDialogOpen({ status: 'saved', fileName: 'x' })).toBe(false);
    expect(recordDialogOpen(RECORD_IDLE)).toBe(false);
  });

  it('classifies capture errors', () => {
    expect(captureErrorReason(new DOMException('no', 'NotAllowedError'))).toBe('denied');
    expect(captureErrorReason({ name: 'AbortError' })).toBe('denied');
    expect(captureErrorReason({ name: 'NotSupportedError' })).toBe('unsupported');
    expect(captureErrorReason(new TypeError('x'))).toBe('unsupported');
    expect(captureErrorReason(new Error('x'))).toBe('failed');
    expect(captureErrorReason(null)).toBe('failed');
  });
});

describe('FR-081 recording glue', () => {
  it('honours the E2E duration hook only for positive numbers', () => {
    const g = globalThis as { __basShow?: unknown };
    expect(recordLimitMs(60_000)).toBe(60_000);
    g.__basShow = { recordSeconds: 2 };
    expect(recordLimitMs(60_000)).toBe(2_000);
    g.__basShow = { recordSeconds: -1 };
    expect(recordLimitMs(60_000)).toBe(60_000);
    g.__basShow = { recordSeconds: '2' };
    expect(recordLimitMs(60_000)).toBe(60_000);
    delete g.__basShow;
  });

  it('records chunks into one blob and stops every track afterwards', () => {
    class FakeRecorder {
      static last: FakeRecorder;
      state: 'inactive' | 'recording' = 'inactive';
      mimeType: string;
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(_s: unknown, o: { mimeType: string }) { this.mimeType = o.mimeType; FakeRecorder.last = this; }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['abc']) }); this.onstop?.(); }
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    const trackStop = vi.fn();
    const ended: (() => void)[] = [];
    const track = { stop: trackStop, addEventListener: (_: string, f: () => void) => ended.push(f) };
    const stream = { getTracks: () => [track, track], getVideoTracks: () => [track] } as unknown as MediaStream;
    const done = vi.fn();
    const rec = recordStream(stream, 'video/webm;codecs=vp9', done);
    expect(FakeRecorder.last.state).toBe('recording');
    rec.stop();
    rec.stop();
    expect(done).toHaveBeenCalledTimes(1);
    const result = done.mock.calls[0]![0] as { ok: boolean; blob: Blob; mime: string };
    expect(result.ok).toBe(true);
    expect(result.mime).toBe('video/webm;codecs=vp9');
    expect(result.blob.size).toBe(3);
    expect(trackStop).toHaveBeenCalledTimes(2);

    // Ending the share from the browser UI also stops and saves.
    const done2 = vi.fn();
    recordStream(stream, 'video/webm', done2);
    ended.at(-1)!();
    expect(done2).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    vi.unstubAllGlobals();
  });

  it('reports failure and still releases the capture when the recorder cannot be created', () => {
    vi.stubGlobal('MediaRecorder', class { constructor() { throw new Error('NotSupported'); } });
    const trackStop = vi.fn();
    const stream = { getTracks: () => [{ stop: trackStop }], getVideoTracks: () => [] } as unknown as MediaStream;
    const done = vi.fn();
    recordStream(stream, 'video/webm', done);
    expect(done).toHaveBeenCalledWith({ ok: false });
    expect(trackStop).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
