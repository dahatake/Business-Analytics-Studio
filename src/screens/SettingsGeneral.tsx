import { useState } from 'react';
import { Button, Label, Link, Radio, RadioGroup, Slider, Switch } from '@fluentui/react-components';
import { PARAMS } from '../config/params.ts';
import { loaded } from '../data/pack.ts';
import type { EntityKind } from '../data/schema.ts';
import { useI18n, type Lang } from '../i18n/index.ts';
import { useSettings, type Audience, type MotionPref, type ThemePref } from '../state/settings.ts';
import { percentile, runFeed, stopFeed, useFeed } from '../state/feed.ts';
import { PageHeader, Panel } from '../ui/Panel.tsx';
import { cardSpecs, type CardSpec } from '../ui/cardSpecs.ts';
import { kindIcon } from '../ui/icons.ts';
import { hrefFor } from '../state/router.ts';
import { openAiSettings } from '../modules/ai/uiStore.ts';
import type { MessageKey } from '../i18n/index.ts';
import { DataLocationPanel } from './DataLocationPanel.tsx';
import { ConfidentialPanel } from './ConfidentialPanel.tsx';
import { useConfidential } from '../state/confidential.ts';

/** D-7 (proposal P-03, approved 2026-11-09): what is kept and how it is deleted. */
const RETENTION: { target: MessageKey; retention: MessageKey; deletion: MessageKey; where?: string; aiSettings?: true }[] = [
  { target: 'retention.pack', retention: 'retention.keep.untilReplaced', deletion: 'retention.del.packFile' },
  { target: 'retention.cache', retention: 'retention.keep.cache', deletion: 'retention.del.cacheFolder' },
  { target: 'retention.project', retention: 'retention.keep.untilDeleted', deletion: 'retention.del.project', where: '/projects' },
  { target: 'retention.importedPack', retention: 'retention.keep.untilDeleted', deletion: 'retention.del.importedPack', where: '/data' },
  { target: 'retention.connection', retention: 'retention.keep.untilDeleted', deletion: 'retention.del.connection', aiSettings: true },
  { target: 'retention.ledger', retention: 'retention.keep.ledger', deletion: 'retention.del.ledger' },
  { target: 'retention.exports', retention: 'retention.keep.outside', deletion: 'retention.del.exports' },
  { target: 'retention.chat', retention: 'retention.keep.notStored', deletion: 'retention.del.none' },
  { target: 'retention.confidential', retention: 'retention.keep.confidential', deletion: 'retention.del.confidential' },
];

/** AI rows open the single AI settings dialog (D-25); other rows link to their screen. */
function deletionCell(r: (typeof RETENTION)[number], label: string) {
  if (r.aiSettings) return <Link inline className="text-action" onClick={openAiSettings}>{label}</Link>;
  if (r.where) return <a href={hrefFor(r.where)}>{label}</a>;
  return label;
}

function LoadTest() {
  const { t, fmt } = useI18n();
  const [result, setResult] = useState<{ p50: number; p95: number; n: number } | null>(null);
  const [running, setRunning] = useState(false);
  const start = () => {
    setRunning(true);
    setResult(null);
    useFeed.getState().resetStats();
    useFeed.getState().setPaused(false);
    useFeed.getState().setLoadRate(PARAMS.liveFeedLoadRatePerSec);
    runFeed();
    window.setTimeout(() => {
      const l = useFeed.getState().latencies;
      setResult({ p50: percentile(l, 50), p95: percentile(l, 95), n: l.length });
      useFeed.getState().setLoadRate(null);
      stopFeed();
      setRunning(false);
    }, PARAMS.liveFeedLoadDurationMs);
  };
  return (
    <div className="load-test">
      <p>{t('settings.loadTest.condition', { rate: PARAMS.liveFeedLoadRatePerSec, seconds: PARAMS.liveFeedLoadDurationMs / 1000, budget: PARAMS.liveFeedLatencyBudgetP95Ms })}</p>
      <Button onClick={start} disabled={running} data-testid="load-test">{running ? t('settings.loadTest.running') : t('settings.loadTest.run')}</Button>
      {result && (
        <p role="status" data-testid="load-test-result">
          {t(result.p95 <= PARAMS.liveFeedLatencyBudgetP95Ms ? 'settings.loadTest.pass' : 'settings.loadTest.fail', { p50: fmt.number(result.p50), p95: fmt.number(result.p95), n: result.n })}
        </p>
      )}
    </div>
  );
}

export function SettingsScreen() {
  const { t } = useI18n();
  const s = useSettings();
  const kinds = Object.keys(cardSpecs) as EntityKind[];
  const retentionDays = useConfidential((c) => c.retentionDays);

  return (
    <div className="screen screen-settings">
      <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />
      <div className="grid-2">
        <Panel title={t('settings.display')}>
          <RadioGroup value={s.lang} onChange={(_, d) => s.setLang(d.value as Lang)} aria-labelledby="lbl-lang">
            <Label id="lbl-lang">{t('lang.label')}</Label>
            <Radio value="ja" label={<span lang="ja">日本語</span>} />
            <Radio value="en" label={<span lang="en">English</span>} />
          </RadioGroup>
          <RadioGroup value={s.theme} onChange={(_, d) => s.setTheme(d.value as ThemePref)} aria-labelledby="lbl-theme">
            <Label id="lbl-theme">{t('settings.theme')}</Label>
            <Radio value="dark" label={t('settings.theme.dark')} />
            <Radio value="light" label={t('settings.theme.light')} />
            <Radio value="system" label={t('settings.theme.system')} />
          </RadioGroup>
          <RadioGroup value={s.audience} onChange={(_, d) => s.setAudience(d.value as Audience)} aria-labelledby="lbl-aud">
            <Label id="lbl-aud">{t('settings.audience')}</Label>
            <Radio value="internal" label={t('audience.internal')} />
            <Radio value="external" label={t('audience.external')} />
          </RadioGroup>
        </Panel>
        <Panel title={t('settings.motionAndSound')}>
          <RadioGroup value={s.motion} onChange={(_, d) => s.setMotion(d.value as MotionPref)} aria-labelledby="lbl-motion">
            <Label id="lbl-motion">{t('settings.motion')}</Label>
            <Radio value="system" label={t('settings.motion.system')} />
            <Radio value="reduce" label={t('settings.motion.reduce')} />
            <Radio value="full" label={t('settings.motion.full')} />
          </RadioGroup>
          <Switch
            checked={s.showSplash}
            onChange={(_, d) => s.setShowSplash(d.checked)}
            label={t('settings.showSplash')}
            data-testid="startup-splash-toggle"
          />
          <Switch checked={!s.muted} onChange={(_, d) => s.setMuted(!d.checked)} label={t('settings.sound')} />
          <Switch checked={s.bgm} onChange={(_, d) => s.setBgm(d.checked)} label={t('settings.bgm')} disabled={s.muted} />
          <Switch checked={s.sfx} onChange={(_, d) => s.setSfx(d.checked)} label={t('settings.sfx')} disabled={s.muted} />
          <div className="control">
            <Label htmlFor="volume">{t('settings.volume', { value: Math.round(s.volume * 100) })}</Label>
            <Slider id="volume" min={0} max={100} value={Math.round(s.volume * 100)} onChange={(_, d) => s.setVolume(d.value / 100)} disabled={s.muted} />
          </div>
          <p className="muted">{t('settings.soundNote')}</p>
        </Panel>
      </div>
      <DataLocationPanel />
      <ConfidentialPanel />
      <Panel title={t('settings.loadTest')}>
        <LoadTest />
      </Panel>
      <Panel title={t('settings.cardTargets')} rationale="visual.cardTargets" testId="card-targets">
        <p>{t('settings.cardTargetsIntro')}</p>
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr>
              <th scope="col">{t('settings.col.kind')}</th>
              <th scope="col">{t('settings.col.fields')}</th>
              <th scope="col">{t('settings.col.internalFields')}</th>
              <th scope="col">{t('settings.col.drill')}</th>
            </tr></thead>
            <tbody>
              {kinds.map((k) => {
                const spec = cardSpecs[k] as CardSpec;
                const Icon = kindIcon[k];
                return (
                  <tr key={k}>
                    <th scope="row"><Icon aria-hidden /> {t(`kind.${k}`)}</th>
                    <td>{spec.fields.map((f) => t(f.label)).join(t('list.separator'))}</td>
                    <td>{spec.fields.filter((f) => f.internal).map((f) => t(f.label)).join(t('list.separator')) || '—'}</td>
                    <td>{spec.route ? t('settings.drill.yes') : t('settings.drill.no')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title={t('retention.title')} rationale="retention.why" testId="retention">
        <p>{t('retention.intro')}</p>
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr>
              <th scope="col">{t('retention.col.target')}</th>
              <th scope="col">{t('retention.col.retention')}</th>
              <th scope="col">{t('retention.col.deletion')}</th>
            </tr></thead>
            <tbody>
              {RETENTION.map((r) => (
                <tr key={r.target}>
                  <th scope="row">{t(r.target)}</th>
                  <td>{t(r.retention, { days: retentionDays })}</td>
                  <td>{deletionCell(r, t(r.deletion))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title={t('settings.validation')}>
        <p role="status">{loaded.issues.length === 0 ? t('settings.validation.ok', { count: loaded.pack.entities.length }) : t('settings.validation.issues', { count: loaded.issues.length })}</p>
      </Panel>
    </div>
  );
}
