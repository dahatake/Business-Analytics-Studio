import { useMemo, useState } from 'react';
import { Field, Select } from '@fluentui/react-components';
import { loaded } from '../../data/pack.ts';
import { useI18n } from '../../i18n/index.ts';
import { Panel } from '../../ui/Panel.tsx';
import { SEMANTICS, type Semantic } from './extensions.ts';
import { assessSuitability, QUESTIONS, RELATION_TYPES, semanticOf, customLabelOf, type Question } from './model.ts';
import type { NormalizedGraphExtension } from './extensions.ts';

/** FR-235: graph-suitability criteria as an interactive panel + per-relation table. */
export function SuitabilityPanel({ ext }: { ext: NormalizedGraphExtension }) {
  const { t, tx } = useI18n();
  const [semantic, setSemantic] = useState<Semantic>('causality');
  const [directed, setDirected] = useState(true);
  const [question, setQuestion] = useState<Question>('chain');
  const result = assessSuitability(semantic, directed, question);
  const usedTypes = useMemo(() => RELATION_TYPES.filter((r) => loaded.edges.some((e) => e.type === r)), []);

  return (
    <div className="split">
      <Panel title={t('graph.suit.title')} rationale="graph.why.suit" testId="graph-suitability">
        <p className="muted">{t('graph.suit.intro')}</p>
        <div className="graph-suit-form">
          <Field label={t('graph.suit.semantic')}>
            <Select value={semantic} onChange={(_, d) => setSemantic(d.value as Semantic)}>
              {SEMANTICS.map((s) => <option key={s} value={s}>{t(`graph.sem.${s}`)}</option>)}
            </Select>
          </Field>
          <Field label={t('graph.suit.direction')}>
            <Select value={directed ? 'directed' : 'undirected'} onChange={(_, d) => setDirected(d.value === 'directed')}>
              <option value="directed">{t('graph.suit.directed')}</option>
              <option value="undirected">{t('graph.suit.undirected')}</option>
            </Select>
          </Field>
          <Field label={t('graph.suit.question')}>
            <Select value={question} onChange={(_, d) => setQuestion(d.value as Question)}>
              {QUESTIONS.map((q) => <option key={q} value={q}>{t(`graph.q.${q}`)}</option>)}
            </Select>
          </Field>
        </div>
        <div className={`graph-suit-result ${result.suitable ? 'is-yes' : 'is-no'}`} role="status" data-testid="graph-suit-result" data-suitable={String(result.suitable)}>
          <p className="graph-suit-verdict"><span aria-hidden="true">{result.suitable ? '✓' : '✕'}</span> {t(result.suitable ? 'graph.suit.yes' : 'graph.suit.no')}</p>
          <p>{t(`graph.suit.reason.${result.reason}`)}</p>
          <p className="muted">{t('graph.suit.recommend', { format: t(`graph.rec.${result.recommend}`) })}</p>
        </div>
      </Panel>
      <Panel title={t('graph.suit.tableTitle')} rationale="graph.why.table">
        <div>
          <table className="data-table compact">
            <caption>{t('graph.suit.tableCaption', { question: t(`graph.q.${question}`) })}</caption>
            <thead>
              <tr>
                <th scope="col">{t('graph.col.relation')}</th>
                <th scope="col">{t('graph.col.semantic')}</th>
                <th scope="col">{t('graph.col.verdict')}</th>
              </tr>
            </thead>
            <tbody>
              {usedTypes.map((r) => {
                const sem = semanticOf(r, ext);
                const res = assessSuitability(sem, true, question);
                const custom = customLabelOf(r, ext);
                return (
                  <tr key={r}>
                    <th scope="row">{custom ? tx(custom) : t(`relation.${r}`)}</th>
                    <td>{t(`graph.sem.${sem}`)}</td>
                    <td>{res.suitable ? t('graph.suit.yes') : t('graph.suit.no')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
