import { useRef, useState } from 'react';
import { Badge, Button, MessageBar, MessageBarBody, Spinner } from '@fluentui/react-components';
import { Dismiss20Regular, Lightbulb20Regular, Open16Regular } from '@fluentui/react-icons';
import { aiComplete, registerMock, type AiResponse } from '../../ai/client.ts';
import { PER_USE_LIMITS } from '../../ai/policy.ts';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { LiveNotice, MockNotice } from '../ai/AiCommon.tsx';
import '../ai/liveTransport.ts';
import { ScrollRegion } from './common.tsx';
import { Glyph } from './stepCharts.tsx';
import {
  CONCEPT_REFS, EXPLAIN_CONCEPTS, explainFacts, explainPrompt, parseExplain, REFERENCES, ruleExplanation, valueTree,
  type ExplainCheck, type ExplainConcept, type ExplainInput, type TreeNode, type WorkedExample,
} from './valueExplain.ts';

/*
 * FR-336: [Copilotで説明]. The narrative comes from Copilot (or, without a live connection, the labelled on-device
 * version); the diagrams are recomputed from the current model every render, so they follow the what-if controls.
 */

interface Generated {
  check: ExplainCheck;
  mode: AiResponse['mode'];
  blockedReasons: AiResponse['blockedReasons'];
  costJpy?: number | null;
  usage?: AiResponse['usage'];
  hash: string;
}

const pct = (x: number) => `${Math.max(0, Math.min(100, x * 100))}%`;

export function ExplainSection({ input, scope }: { input: ExplainInput; scope: string }) {
  const { t, lang } = useI18n();
  const [generated, setGenerated] = useState<Generated | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const facts = explainFacts(input, lang);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const f = explainFacts(input, lang);
      const rule = ruleExplanation(input, f, lang);
      // The use's only mock (FR-011): the on-device explanation from the same ledger, labelled mock by the screen.
      registerMock('valueExplain', () => JSON.stringify(rule));
      const response = await aiComplete({ use: 'valueExplain', lang, prompt: explainPrompt(input, f, lang), scope, maxOutputTokens: PER_USE_LIMITS.valueExplain?.maxOutputTokens });
      let check: ExplainCheck;
      try { check = parseExplain(response.text, f); } catch { throw new Error(t('val.x.badAnswer')); }
      setGenerated({
        check, mode: response.mode, blockedReasons: response.blockedReasons, hash: f.hash,
        ...(response.costJpy !== undefined ? { costJpy: response.costJpy } : {}), ...(response.usage ? { usage: response.usage } : {}),
      });
      requestAnimationFrame(() => heading.current?.focus());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const stale = generated !== null && generated.hash !== facts.hash;
  const unverifiedAll = generated ? Object.values(generated.check.unverified).flat() : [];
  return (
    <section className="val-section val-explain" aria-labelledby="val-explain-title" data-testid="val-explain">
      <div className="proj-row">
        <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <Lightbulb20Regular />} disabled={busy} onClick={() => void run()} data-testid="val-explain-run">
          {t(generated ? 'val.x.again' : 'val.x.run')}
        </Button>
        {generated && <Button appearance="subtle" icon={<Dismiss20Regular />} onClick={() => setGenerated(null)} data-testid="val-explain-close">{t('val.x.close')}</Button>}
        <span className="muted">{t('val.x.hint')}</span>
      </div>
      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      {generated && (
        <div className="val-explain-body" data-testid="val-explain-body" data-mode={generated.mode} data-stale={stale}>
          <h3 id="val-explain-title" className="step-chart-title" tabIndex={-1} ref={heading}>{t('val.x.title')}</h3>
          {generated.mode === 'mock'
            ? <MockNotice reasons={generated.blockedReasons}>{t('val.x.mock')}</MockNotice>
            : <LiveNotice costJpy={generated.costJpy ?? null} {...(generated.usage ? { usage: generated.usage } : {})} />}
          {stale && <MessageBar intent="warning" data-testid="val-explain-stale"><MessageBarBody>{t('val.x.stale')}</MessageBarBody></MessageBar>}
          {unverifiedAll.length > 0
            ? <MessageBar intent="warning" data-testid="val-explain-unverified"><MessageBarBody>{t('val.x.unverified', { list: [...new Set(unverifiedAll)].join(', ') })}</MessageBarBody></MessageBar>
            : <p className="muted" data-testid="val-explain-verified">{t('val.x.verified', { n: generated.check.checked })}</p>}
          <p className="val-explain-headline" data-testid="val-explain-headline">{generated.check.content.headline}</p>
          {EXPLAIN_CONCEPTS.map((c, i) => (
            <ConceptBlock key={c} n={i + 1} concept={c} text={generated.check.content.sections[c] ?? ''} unverified={generated.check.unverified[c] ?? []} input={input} example={facts.example} />
          ))}
          {generated.check.content.questions.length > 0 && (
            <section className="val-explain-concept" aria-labelledby="val-explain-q">
              <h4 id="val-explain-q">{t('val.x.questions')}</h4>
              <ol data-testid="val-explain-questions">{generated.check.content.questions.map((q, i) => <li key={i}>{q}</li>)}</ol>
            </section>
          )}
          <p className="muted">{t('val.x.howVisual')}</p>
          <RefList ids={['berinato2016']} />
        </div>
      )}
    </section>
  );
}

function ConceptBlock({ n, concept, text, unverified, input, example }: { n: number; concept: ExplainConcept; text: string; unverified: string[]; input: ExplainInput; example: WorkedExample | null }) {
  const { t } = useI18n();
  const id = `val-explain-${concept}`;
  return (
    <section className="val-explain-concept" aria-labelledby={id} data-testid={id}>
      <h4 id={id}>{`${n}. ${t(`val.x.c.${concept}` as MessageKey)}`}</h4>
      <p className="muted val-explain-why">{t(`val.x.why.${concept}` as MessageKey)}</p>
      {text && <p data-testid={`${id}-text`}>{text}</p>}
      {unverified.length > 0 && <Badge appearance="outline" color="warning">{t('val.x.unverifiedHere', { list: unverified.join(', ') })}</Badge>}
      <ConceptVisual concept={concept} input={input} example={example} />
      <RefList ids={CONCEPT_REFS[concept]} />
    </section>
  );
}

function RefList({ ids }: { ids: string[] }) {
  const { t, lang } = useI18n();
  return (
    <details className="val-refs" open>
      <summary>{t('val.x.refs')}</summary>
      <ul>
        {ids.map((id) => {
          const r = REFERENCES[id]!;
          return (
            <li key={id} data-ref={id}>
              <Badge size="small" appearance="tint" color="informative">{t(`val.x.kind.${r.kind}` as MessageKey)}</Badge>{' '}
              <a href={r.url} target="_blank" rel="noopener noreferrer">{r.cite} <Open16Regular aria-label={t('val.x.newTab')} /></a>
              <p className="muted">{r.summary[lang]}</p>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function ConceptVisual({ concept, input, example }: { concept: ExplainConcept; input: ExplainInput; example: WorkedExample | null }) {
  switch (concept) {
    case 'npv': return <NpvVisual input={input} />;
    case 'lineage': return <TreeVisual input={input} />;
    case 'worked': return example ? <WorkedVisual ex={example} name={input.names[example.lineId] ?? example.lineId} rate={input.model.discountRate} /> : null;
    case 'uncertainty': return <UncertaintyVisual input={input} example={example} />;
    case 'sensitivity': return <SensitivityVisual input={input} />;
    case 'robustness': return <RobustnessVisual input={input} />;
    case 'portfolio': return <PortfolioVisual input={input} />;
  }
}

/* ---------- Diagrams (computed from the engine's own values) ---------- */

function NpvVisual({ input }: { input: ExplainInput }) {
  const { t, fmt } = useI18n();
  const r = input.result;
  const inv = -(r.levers.investment ?? 0);
  const pvBenefits = r.npv.mode + inv;
  return (
    <div className="val-chain" data-testid="val-explain-npv-chain">
      <span className="val-chain-box"><small>{t('val.x.v.pvBenefits')}</small><strong>{fmt.yenCompact(pvBenefits)}</strong></span>
      <span className="val-chain-op" aria-hidden="true">−</span>
      <span className="val-chain-box"><small>{t('val.x.v.investment')}</small><strong>{fmt.yenCompact(inv)}</strong></span>
      <span className="val-chain-op" aria-hidden="true">=</span>
      <span className="val-chain-box is-result"><small>{t('val.npvMode')}</small><strong>{fmt.yenCompact(r.npv.mode)}</strong> <Glyph ok={r.npv.mode >= 0} /></span>
      <span className="visually-hidden">{t('val.x.v.npvRead', { pv: fmt.yenCompact(pvBenefits), inv: fmt.yenCompact(inv), npv: fmt.yenCompact(r.npv.mode) })}</span>
    </div>
  );
}

function TreeVisual({ input }: { input: ExplainInput }) {
  const { t } = useI18n();
  const tree = valueTree(input.model, input.result);
  const all: TreeNode[] = [];
  const walk = (n: TreeNode) => { all.push(n); n.children.forEach(walk); };
  walk(tree);
  const max = Math.max(1, ...all.map((n) => Math.abs(n.value)));
  return (
    <div className="val-tree" data-testid="val-explain-tree">
      <p className="muted">{t('val.x.v.treeRead')}</p>
      <ul aria-label={t('val.x.c.lineage')}><TreeItem node={tree} max={max} names={input.names} /></ul>
    </div>
  );
}

function TreeItem({ node, max, names }: { node: TreeNode; max: number; names: Record<string, string> }) {
  const { t, fmt } = useI18n();
  const label = node.kind === 'npv' ? t('val.npvMode')
    : node.kind === 'investment' ? t('val.driver.investment')
      : node.kind === 'driver' ? t(`val.driver.${node.key}` as MessageKey)
        : node.kind === 'other' ? t('val.x.v.other', { n: node.key })
          : names[node.key] ?? node.key;
  const rule = node.kind === 'npv' ? t('val.x.v.ruleNpv') : node.kind === 'driver' ? t('val.x.v.ruleDriver') : node.kind === 'line' ? t('val.x.v.ruleLine') : '';
  return (
    <li data-node={node.id} data-value={node.value}>
      <span className={`val-tree-node is-${node.kind}`}>
        <span className="val-tree-label">{label}</span>
        <span className="val-tree-bar"><span className={`step-chart-bar ${node.value < 0 ? 'is-bad val-hatch' : node.kind === 'npv' ? 'is-good' : 'is-brand'}`} style={{ width: pct(Math.abs(node.value) / max) }} /></span>
        <span className="step-chart-value">{fmt.yenCompact(node.value)}</span>
        {rule && <small className="muted val-tree-rule">{rule}</small>}
      </span>
      {node.children.length > 0 && <ul>{node.children.map((c) => <TreeItem key={c.id} node={c} max={max} names={names} />)}</ul>}
    </li>
  );
}

function WorkedVisual({ ex, name, rate }: { ex: WorkedExample; name: string; rate: number }) {
  const { t, fmt } = useI18n();
  const maxF = Math.max(1e-9, ...ex.years.map((y) => y.factor));
  return (
    <div className="val-worked" data-testid="val-x-worked" data-pv={ex.pv}>
      <p><strong>{name}</strong></p>
      <div className="val-chain">
        <span className="val-chain-box"><small>{t('val.x.v.amount')}</small><strong>{fmt.yenCompact(ex.amount)}</strong></span>
        <span className="val-chain-op" aria-hidden="true">×</span>
        <span className="val-chain-box"><small>{t('val.x.v.conversion')}</small><strong>{fmt.percent(ex.conversion)}</strong></span>
        {Math.abs(ex.adjust - 1) > 1e-9 && (
          <>
            <span className="val-chain-op" aria-hidden="true">×</span>
            <span className="val-chain-box"><small>{t('val.x.v.adjust')}</small><strong>{fmt.number(Math.round(ex.adjust * 100) / 100)}</strong></span>
          </>
        )}
        <span className="val-chain-op" aria-hidden="true">=</span>
        <span className="val-chain-box"><small>{t(ex.oneOff ? 'val.x.v.cashOnce' : 'val.x.v.cash')}</small><strong>{fmt.yenCompact(ex.cash)}</strong></span>
        <span className="val-chain-op" aria-hidden="true">×</span>
        <span className="val-chain-box"><small>{t('val.x.v.factor', { rate: fmt.percent(rate) })}</small><strong>{fmt.number(Math.round(ex.factor * 100) / 100)}</strong></span>
        <span className="val-chain-op" aria-hidden="true">=</span>
        <span className="val-chain-box is-result"><small>{t('val.x.v.pv')}</small><strong>{fmt.yenCompact(ex.pv)}</strong></span>
      </div>
      <p className="muted">{t(ex.oneOff ? 'val.x.v.factorReadOnce' : 'val.x.v.factorRead', { build: fmt.number(Math.round(ex.buildYears * 10) / 10) })}</p>
      <div className="val-years" role="img" aria-label={t('val.x.v.yearsLabel', { list: ex.years.map((y) => `${y.year}: ${fmt.number(Math.round(y.factor * 100) / 100)}`).join(', ') })}>
        {ex.years.map((y) => (
          <span key={y.year} className="val-year">
            <span className="val-year-bar" style={{ height: pct(y.factor / maxF) }} />
            <small>{t('val.x.v.year', { n: y.year })}</small>
          </span>
        ))}
      </div>
      <details className="step-chart-data">
        <summary>{t('proj.dash.chart.table')}</summary>
        <ScrollRegion label={t('val.x.v.yearTable')}>
          <table className="data-table compact">
            <thead><tr>
              <th scope="col">{t('val.x.v.yearCol')}</th><th scope="col" className="num">{t('val.x.v.share')}</th>
              <th scope="col" className="num">{t('val.x.v.discount')}</th><th scope="col" className="num">{t('val.x.v.factorCol')}</th>
              <th scope="col" className="num">{t('val.x.v.pv')}</th>
            </tr></thead>
            <tbody>
              {ex.years.map((y) => (
                <tr key={y.year}>
                  <th scope="row">{t('val.x.v.year', { n: y.year })}</th>
                  <td className="num">{fmt.percent(y.share)}</td>
                  <td className="num">{fmt.number(Math.round(y.discount * 1000) / 1000)}</td>
                  <td className="num">{fmt.number(Math.round(y.factor * 1000) / 1000)}</td>
                  <td className="num">{fmt.yenCompact(ex.cash * y.factor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      </details>
    </div>
  );
}

function UncertaintyVisual({ input, example }: { input: ExplainInput; example: WorkedExample | null }) {
  const { t, fmt } = useI18n();
  const r = input.result;
  const line = example ? input.model.lines.find((l) => l.id === example.lineId) : undefined;
  const lo = Math.min(0, r.npv.p10, input.independent?.npv.p10 ?? r.npv.p10);
  const hi = Math.max(0, r.npv.p90, input.independent?.npv.p90 ?? r.npv.p90);
  const x = (v: number) => pct((v - lo) / (hi - lo || 1));
  const band = (a: number, b: number, kind: string, label: string, testId: string) => (
    <div className="step-chart-row" data-testid={testId}>
      <span className="step-chart-label">{label}</span>
      <span className="step-chart-track is-plain">
        <span className={`step-chart-band ${kind}`} style={{ left: x(a), width: `calc(${x(b)} - ${x(a)})` }} />
        <span className="step-chart-mark is-target" style={{ left: x(0) }} />
      </span>
      <span className="step-chart-value">{`${fmt.yenCompact(a)} – ${fmt.yenCompact(b)}`}</span>
    </div>
  );
  return (
    <div className="val-uncertainty" data-testid="val-x-uncertainty">
      {line && (
        <div className="val-tri-row">
          <svg className="val-tri" viewBox="0 0 120 50" role="img" aria-label={t('val.x.v.triLabel', { low: fmt.yenCompact(line.amount.low), mode: fmt.yenCompact(line.amount.mode), high: fmt.yenCompact(line.amount.high) })}>
            {(() => {
              const span = line.amount.high - line.amount.low || 1;
              const m = 10 + ((line.amount.mode - line.amount.low) / span) * 100;
              return <polygon points={`10,45 ${m},5 110,45`} className="val-tri-shape" />;
            })()}
          </svg>
          <span className="muted">{t('val.x.v.triRead', { low: fmt.yenCompact(line.amount.low), mode: fmt.yenCompact(line.amount.mode), high: fmt.yenCompact(line.amount.high), runs: fmt.number(r.runs) })}</span>
        </div>
      )}
      <div className="step-chart-rows">
        {band(r.npv.p10, r.npv.p90, '', t('val.x.v.bandWith'), 'val-explain-band')}
        {input.independent && band(input.independent.npv.p10, input.independent.npv.p90, 'val-band-alt', t('val.x.v.bandWithout'), 'val-explain-band-indep')}
      </div>
    </div>
  );
}

function SensitivityVisual({ input }: { input: ExplainInput }) {
  const { t, fmt } = useI18n();
  const top = input.result.tornado.slice(0, 3);
  if (!top.length) return null;
  const max = Math.max(1, ...top.map((b) => b.swing));
  const label = (b: (typeof top)[number]) => (b.kind === 'rate' ? t('val.kind.rate') : b.kind === 'cost' ? t('val.kind.cost', { name: input.names[b.ref] ?? b.ref }) : t(`val.kind.${b.kind}` as MessageKey, { name: input.names[b.ref] ?? b.ref }));
  return (
    <div className="step-chart-rows" data-testid="val-x-sensitivity">
      {top.map((b, i) => (
        <div key={b.id} className="step-chart-row">
          <span className="step-chart-label">{`${i + 1}. ${label(b)}`}</span>
          <span className="step-chart-track"><span className="step-chart-bar is-brand" style={{ width: pct(b.swing / max) }} /></span>
          <span className="step-chart-value">{fmt.yenCompact(b.swing)}</span>
        </div>
      ))}
    </div>
  );
}

function RobustnessVisual({ input }: { input: ExplainInput }) {
  const { t, fmt } = useI18n();
  const r = input.result;
  const rate = input.model.discountRate;
  const points = [
    ...(r.stress ? [{ id: 'stress', v: r.stress.npv, label: t('val.stat.stress') }] : []),
    { id: 'p10', v: r.npv.p10, label: t('proj.dash.col.p10') }, { id: 'p50', v: r.npv.p50, label: t('proj.dash.col.p50') }, { id: 'p90', v: r.npv.p90, label: t('proj.dash.col.p90') },
  ];
  const lo = Math.min(0, ...points.map((p) => p.v));
  const hi = Math.max(0, ...points.map((p) => p.v));
  const x = (v: number) => pct((v - lo) / (hi - lo || 1));
  const rateMax = Math.max(rate, Math.min(r.irr ?? 0, 1)) * 1.15 || 0.1;
  const xr = (v: number) => pct(Math.min(v, rateMax) / rateMax);
  return (
    <div className="step-chart-rows" data-testid="val-x-robustness">
      <div className="step-chart-row">
        <span className="step-chart-label">{t('val.x.v.rateScale')}</span>
        <span className="step-chart-track is-plain">
          {r.irr !== null && <span className="step-chart-bar is-good is-float" style={{ left: 0, width: xr(r.irr) }} />}
          <span className="step-chart-mark is-target" style={{ left: xr(rate) }} />
        </span>
        <span className="step-chart-value">{r.irr === null ? '–' : t('val.x.v.irrVsRate', { irr: fmt.percent(r.irr), rate: fmt.percent(rate) })}</span>
      </div>
      {points.map((p) => (
        <div key={p.id} className="step-chart-row" data-point={p.id}>
          <span className="step-chart-label">{p.label}</span>
          <span className="step-chart-track is-plain">
            <span className="step-chart-mark is-target" style={{ left: x(0) }} />
            <span className={`step-chart-dot${p.v < 0 ? '' : ' is-total'}`} style={{ left: x(p.v) }} />
          </span>
          <span className="step-chart-value">{fmt.yenCompact(p.v)} <Glyph ok={p.v >= 0} /></span>
        </div>
      ))}
    </div>
  );
}

function PortfolioVisual({ input }: { input: ExplainInput }) {
  const { t, fmt } = useI18n();
  const rows = input.result.solutions.filter((s) => input.linked.includes(s.id));
  if (!rows.length) return null;
  return (
    <ScrollRegion label={t('val.x.c.portfolio')}>
      <table className="data-table compact" data-testid="val-x-portfolio">
        <thead><tr><th scope="col">{t('val.col.solution')}</th><th scope="col" className="num">{t('val.col.standalone')}</th><th scope="col" className="num">{t('val.col.marginal')}</th><th scope="col" className="num">{t('val.x.v.linkValue')}</th></tr></thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id}>
              <th scope="row">{input.names[s.id] ?? s.id}</th>
              <td className="num">{fmt.yenCompact(s.standalone)}</td>
              <td className="num">{fmt.yenCompact(s.marginal)}</td>
              <td className="num">{fmt.yenCompact(s.marginal - s.standalone)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
