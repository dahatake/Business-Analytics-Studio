import { useEffect, useId, useState } from 'react';
import { Badge, Button, Input, Label, MessageBar, MessageBarBody, Radio, RadioGroup } from '@fluentui/react-components';
import { loaded } from '../../data/pack.ts';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { useEffectiveDark } from '../../state/motion.ts';
import { PageHeader, Panel } from '../../ui/Panel.tsx';
import { BRAND_TONES, DEFAULT_PRIMARY, fontStack, type BrandTone } from './brand.ts';
import { CONTRAST_TEXT, isHex, normalizeHex, RAMP_STEPS } from './color.ts';
import { INDUSTRY_PRESETS } from './presets.ts';
import { useBrandOverride, useResolvedBrand } from './theme.ts';
import { TEMPLATE_VERSION } from './version.ts';
import './ops.css';

const ratio = (r: number) => `${r.toFixed(2)}:1`;

function packPrimary(): string {
  const b = loaded.pack.extensions?.brand as { primary?: unknown } | undefined;
  return typeof b?.primary === 'string' && isHex(b.primary) ? normalizeHex(b.primary) : DEFAULT_PRIMARY;
}

function OverridePanel() {
  const { t } = useI18n();
  const brand = useResolvedBrand();
  const o = useBrandOverride();
  const [draft, setDraft] = useState(o.primary ?? brand.primary);
  const [font, setFont] = useState(o.fontFamily ?? '');
  const [saved, setSaved] = useState(false);
  const inputId = useId();
  const fontId = useId();
  const valid = isHex(draft);
  useEffect(() => setSaved(false), [draft, font]);
  const apply = () => {
    if (!valid) return;
    o.setPrimary(normalizeHex(draft));
    o.setFontFamily(font);
    setSaved(true);
  };
  const reset = () => {
    o.reset();
    setDraft(packPrimary());
    setFont('');
  };
  return (
    <Panel title={t('ops.override.title')} rationale="ops.override.why" testId="brand-override">
      <p className="muted">{t('ops.override.help')}</p>
      <div className="ops-form">
        <div className="control">
          <Label htmlFor={inputId}>{t('ops.override.primary')}</Label>
          <div className="ops-row">
            <Input id={inputId} value={draft} onChange={(_, d) => setDraft(d.value)} aria-invalid={!valid} aria-describedby={`${inputId}-hint`} data-testid="brand-primary-input" />
            <input type="color" className="ops-color-picker" value={valid ? normalizeHex(draft).toLowerCase() : '#000000'} onChange={(e) => setDraft(e.target.value.toUpperCase())} aria-label={t('ops.override.picker')} />
          </div>
          <span id={`${inputId}-hint`} className={valid ? 'muted' : 'ops-error'} role={valid ? undefined : 'alert'}>{valid ? t('ops.override.primaryHint') : t('ops.override.invalid')}</span>
        </div>
        <div className="control">
          <Label htmlFor={fontId}>{t('ops.override.font')}</Label>
          <Input id={fontId} value={font} onChange={(_, d) => setFont(d.value)} placeholder={t('ops.override.fontPlaceholder')} />
        </div>
        <RadioGroup value={o.tone ?? 'pack'} onChange={(_, d) => o.setTone(d.value === 'pack' ? null : (d.value as BrandTone))} aria-labelledby={`${inputId}-tone`}>
          <Label id={`${inputId}-tone`}>{t('ops.override.tone')}</Label>
          <Radio value="pack" label={t('ops.override.tonePack')} />
          {BRAND_TONES.map((tone) => <Radio key={tone} value={tone} label={t(`ops.tone.${tone}` as MessageKey)} />)}
        </RadioGroup>
        <div className="ops-row">
          <Button appearance="primary" onClick={apply} disabled={!valid} data-testid="brand-apply">{t('ops.override.apply')}</Button>
          <Button onClick={reset} data-testid="brand-reset">{t('ops.override.reset')}</Button>
        </div>
        {saved && <p role="status" className="muted">{t('ops.override.saved')}</p>}
      </div>
    </Panel>
  );
}

function ContrastPanel() {
  const { t } = useI18n();
  const brand = useResolvedBrand();
  const dark = useEffectiveDark();
  const textFails = brand.checks.filter((c) => c.min === CONTRAST_TEXT && !c.pass);
  return (
    <Panel title={t('ops.contrast.title')} rationale="ops.contrast.why" testId="brand-contrast">
      {textFails.length > 0 && (
        <MessageBar intent="warning" data-testid="contrast-warning">
          <MessageBarBody>{t('ops.contrast.warning', { primary: brand.primary, light: brand.applied.lightForeground, dark: brand.applied.darkForeground })}</MessageBarBody>
        </MessageBar>
      )}
      <div className="table-scroll" role="region" aria-label={t('ops.contrast.title')} tabIndex={0}>
        <table className="data-table">
          <thead>
            <tr><th scope="col">{t('ops.contrast.check')}</th><th scope="col">{t('ops.contrast.pair')}</th><th scope="col">{t('ops.contrast.ratio')}</th><th scope="col">{t('ops.contrast.result')}</th></tr>
          </thead>
          <tbody>
            {brand.checks.map((c) => (
              <tr key={c.id} data-testid={`contrast-${c.id}`} data-pass={c.pass}>
                <th scope="row">{t(`ops.contrast.${c.id}` as MessageKey)}</th>
                <td><code>{c.fg}</code> / <code>{c.bg}</code></td>
                <td className="num">{t('ops.contrast.ratioValue', { ratio: ratio(c.ratio), min: ratio(c.min) })}</td>
                <td><Badge appearance="tint" color={c.pass ? 'success' : 'danger'}>{c.pass ? t('ops.contrast.pass') : t('ops.contrast.fail')}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 className="ops-subtitle">{t('ops.contrast.applied')}</h3>
      <ul className="ops-applied">
        <li data-testid="applied-light" data-color={brand.applied.lightForeground}><span className="ops-chip" style={{ background: brand.applied.lightForeground }} aria-hidden />{t('ops.contrast.appliedLight')} <code>{brand.applied.lightForeground}</code></li>
        <li data-testid="applied-dark" data-color={brand.applied.darkForeground}><span className="ops-chip" style={{ background: brand.applied.darkForeground }} aria-hidden />{t('ops.contrast.appliedDark')} <code>{brand.applied.darkForeground}</code></li>
      </ul>
      <p className="ops-brand-sample" data-testid="brand-sample">{t('ops.contrast.sample', { mode: dark ? t('ops.mode.dark') : t('ops.mode.light') })}</p>
      {brand.corrections.length > 0 && <p className="muted" data-testid="brand-corrections">{t('ops.contrast.corrected', { count: brand.corrections.length })}</p>}
    </Panel>
  );
}

function RampPanel() {
  const { t } = useI18n();
  const brand = useResolvedBrand();
  return (
    <Panel title={t('ops.ramp.title')} rationale="ops.ramp.why" testId="brand-ramp" className="span-full">
      <ol className="ops-ramp" aria-label={t('ops.ramp.title')}>
        {RAMP_STEPS.map((s) => (
          <li key={s} data-step={s} data-color={brand.ramp[s]}>
            <span className="ops-swatch" style={{ background: brand.ramp[s] }} aria-hidden />
            <span className="ops-step">{s}{s === brand.primaryStep ? ` ${t('ops.ramp.primaryMark')}` : ''}</span>
            <code>{brand.ramp[s]}</code>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function LogoPanel() {
  const { t, tx } = useI18n();
  const brand = useResolvedBrand();
  const [broken, setBroken] = useState(false);
  const logo = brand.logo;
  const company = tx(loaded.pack.company.name);
  const initials = company.split(/\s+/).map((w) => [...w][0] ?? '').join('').slice(0, 2).toUpperCase();
  return (
    <Panel title={t('ops.logo.title')} rationale="ops.logo.why" testId="brand-logo">
      {logo && !broken ? (
        <div className="ops-logo-frame" style={{ padding: `${logo.clearSpaceRatio * 48}px` }}>
          <img src={`${import.meta.env.BASE_URL}${logo.src}`} alt={tx(logo.alt)} style={{ minWidth: logo.minWidthPx, height: 48 }} onError={() => setBroken(true)} />
        </div>
      ) : (
        <div className="ops-logo-placeholder" role="img" aria-label={t('ops.logo.placeholder', { company })} data-testid="logo-placeholder">
          <span aria-hidden>{initials}</span>
        </div>
      )}
      <ul className="ops-list">
        {logo ? (
          <>
            <li>{t('ops.logo.minWidth', { px: logo.minWidthPx })}</li>
            <li>{t('ops.logo.clearSpace', { ratio: logo.clearSpaceRatio })}</li>
            <li>{t('ops.logo.backgrounds', { list: logo.backgrounds.map((b) => t(`ops.mode.${b}` as MessageKey)).join(', ') })}</li>
            <li>{t('ops.logo.noDistort')}</li>
          </>
        ) : (
          <li>{t('ops.logo.none')}</li>
        )}
      </ul>
    </Panel>
  );
}

function TypePanel() {
  const { t, fmt } = useI18n();
  const brand = useResolvedBrand();
  const stack = fontStack(brand.fonts);
  return (
    <Panel title={t('ops.font.title')} rationale="ops.font.why" testId="brand-font">
      <p>{t('ops.font.stack')} <code className="ops-break">{stack}</code></p>
      <div style={{ fontFamily: stack }} className="ops-font-sample">
        <p>{t('ops.font.sample')}</p>
        <table className="data-table ops-tabular">
          <caption>{t('ops.font.tabular')}</caption>
          <tbody>
            {[1234567.89, 98765.4, 1111111.11].map((n) => (
              <tr key={n}><td className="num">{fmt.number(n)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">{t('ops.font.fallback')}</p>
    </Panel>
  );
}

function ProfilePanel() {
  const { t } = useI18n();
  const brand = useResolvedBrand();
  return (
    <Panel title={t('ops.profile.title')} rationale="ops.profile.why" testId="brand-profile">
      {brand.issues.length > 0 && (
        <MessageBar intent="error"><MessageBarBody>{t('ops.profile.invalid', { issues: brand.issues.join('; ') })}</MessageBarBody></MessageBar>
      )}
      <dl className="ops-dl">
        <dt>{t('ops.profile.origin')}</dt><dd data-testid="brand-origin">{t(`ops.origin.${brand.origin}` as MessageKey)}</dd>
        <dt>{t('ops.profile.primary')}</dt><dd><span className="ops-chip" style={{ background: brand.primary }} aria-hidden /><code data-testid="brand-primary">{brand.primary}</code></dd>
        <dt>{t('ops.profile.tone')}</dt><dd>{t(`ops.tone.${brand.tone}` as MessageKey)}{t('ops.sep')}{t(`ops.toneEffect.${brand.tone}` as MessageKey)}</dd>
        <dt>{t('ops.profile.version')}</dt><dd data-testid="template-version">{TEMPLATE_VERSION}</dd>
        <dt>{t('ops.profile.pack')}</dt><dd>{loaded.pack.isSample ? t('ops.profile.sample') : t('ops.profile.customer')}</dd>
      </dl>
    </Panel>
  );
}

function PresetsPanel() {
  const { t } = useI18n();
  return (
    <Panel title={t('ops.presets.title')} rationale="ops.presets.why" testId="brand-presets" className="span-full">
      <div className="table-scroll" role="region" aria-label={t('ops.presets.title')} tabIndex={0}>
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('ops.presets.name')}</th><th scope="col">{t('ops.presets.scene')}</th><th scope="col">{t('ops.presets.camera')}</th>
              <th scope="col">{t('ops.presets.icons')}</th><th scope="col">{t('ops.presets.core')}</th>
            </tr>
          </thead>
          <tbody>
            {INDUSTRY_PRESETS.map((p) => (
              <tr key={p.id}>
                <th scope="row">{t(`ops.preset.${p.id}` as MessageKey)}</th>
                <td><code>{p.sceneType}</code></td>
                <td><code>{p.cameraPath}</code></td>
                <td><code>{p.iconSet}</code></td>
                <td><code>{p.coreObject.kind}</code> / <code>{p.coreObject.type}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">{t('ops.presets.cli')}</p>
    </Panel>
  );
}

/** /brand: brand profile, ramp, contrast, logo, fonts, tone, override (FR-058〜FR-064), presets (FR-103), version (FR-106). */
export function BrandScreen() {
  const { t } = useI18n();
  return (
    <div className="screen screen-ops">
      <PageHeader title={t('ops.title')} subtitle={t('ops.subtitle', { version: TEMPLATE_VERSION })} />
      <ProfilePanel />
      <OverridePanel />
      <ContrastPanel />
      <LogoPanel />
      <RampPanel />
      <TypePanel />
      <PresetsPanel />
    </div>
  );
}
