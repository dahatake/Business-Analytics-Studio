/**
 * F-3.1.5 sound: BGM and UI sounds synthesized with Web Audio, so there are no audio assets to license (C-06).
 * Nothing is created until the user unmutes (browser autoplay policy, and meetings start silent).
 */
export type Sfx = 'tap' | 'open' | 'success' | 'toggle';

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bgmBus: GainNode | null = null;
  private bgmTimer: number | null = null;
  private chordIndex = 0;
  private state = { muted: true, bgm: true, sfx: true, volume: 0.5 };

  configure(next: { muted: boolean; bgm: boolean; sfx: boolean; volume: number }) {
    this.state = next;
    if (next.muted) {
      this.stopBgm();
      if (this.master && this.ctx) this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
      return;
    }
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    this.master.gain.setTargetAtTime(next.volume, ctx.currentTime, 0.05);
    if (next.bgm) this.startBgm();
    else this.stopBgm();
  }

  get active() {
    return this.ctx !== null && !this.state.muted;
  }

  private ensure(): AudioContext | null {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(this.ctx.destination);
    this.bgmBus = this.ctx.createGain();
    this.bgmBus.gain.value = 0.18;
    const lowpass = this.ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 1400;
    this.bgmBus.connect(lowpass).connect(this.master);
    return this.ctx;
  }

  play(name: Sfx) {
    if (this.state.muted || !this.state.sfx) return;
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    const notes: Record<Sfx, number[]> = { tap: [880], toggle: [660, 990], open: [523.25, 783.99], success: [523.25, 659.25, 783.99] };
    notes[name].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = name === 'tap' ? 'triangle' : 'sine';
      osc.frequency.value = freq;
      const t0 = now + i * 0.06;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.12, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);
      osc.connect(g).connect(this.master!);
      osc.start(t0);
      osc.stop(t0 + 0.3);
    });
  }

  private startBgm() {
    if (this.bgmTimer !== null || !this.ctx) return;
    // Slow, low-contrast pad: Cmaj9 → Am9 → Fmaj7 → G6, 4 s each.
    const chords = [[261.63, 329.63, 392.0, 493.88], [220.0, 261.63, 329.63, 392.0], [174.61, 220.0, 261.63, 329.63], [196.0, 246.94, 293.66, 329.63]];
    const playChord = () => {
      const ctx = this.ctx;
      if (!ctx || !this.bgmBus) return;
      const chord = chords[this.chordIndex++ % chords.length]!;
      const t0 = ctx.currentTime;
      chord.forEach((f) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = f / 2;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(0.08, t0 + 1.5);
        g.gain.linearRampToValueAtTime(0, t0 + 4.4);
        osc.connect(g).connect(this.bgmBus!);
        osc.start(t0);
        osc.stop(t0 + 4.5);
      });
    };
    playChord();
    this.bgmTimer = window.setInterval(playChord, 4000);
  }

  private stopBgm() {
    if (this.bgmTimer !== null) window.clearInterval(this.bgmTimer);
    this.bgmTimer = null;
  }
}

export const sound = new SoundEngine();
