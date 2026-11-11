import { useEffect, useState } from 'react';
import { appStorage as localStorage } from '../../data/deviceStorage.ts';
import type { Lang } from '../../i18n/core.ts';

const PREF_KEY = 'bas.uc.readAloud';

/** FR-167: caption read-aloud uses only the browser's local speech synthesis (nothing is sent anywhere). */
export function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';
}

export function voiceFor(lang: Lang): SpeechSynthesisVoice | undefined {
  if (!speechSupported()) return undefined;
  return window.speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(lang));
}

export function speak(text: string, lang: Lang): void {
  if (!speechSupported() || !text.trim()) return;
  const synth = window.speechSynthesis;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang === 'ja' ? 'ja-JP' : 'en-US';
  const v = voiceFor(lang);
  if (v) u.voice = v;
  synth.speak(u);
}

export function stopSpeaking(): void {
  if (speechSupported()) window.speechSynthesis.cancel();
}

/** Off by default (FR-167); the choice is remembered on this device. */
export function useReadAloud(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(PREF_KEY) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(PREF_KEY, on ? '1' : '0');
    } catch {
      /* storage unavailable: keep the in-memory choice */
    }
    if (!on) stopSpeaking();
  }, [on]);
  return [on, setOn];
}
