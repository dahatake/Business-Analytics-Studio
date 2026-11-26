import { useId, useMemo, useRef } from 'react';
import { getEntity, loaded } from '../data/pack.ts';
import type { WorkflowExtension } from '../data/extensionSchemas.ts';
import { useI18n } from '../i18n/index.ts';
import { replaceQuery, useRoute } from '../state/router.ts';
import { loc, type Localizable } from '../state/text.ts';
import { EntityRef } from '../ui/EntityRef.tsx';

type Stage = WorkflowExtension['stages'][number];

export function WorkflowFields({ stage, showMissing = false }: { stage: Stage; showMissing?: boolean }) {
  const { t, lang } = useI18n();
  const list = (label: string, items: readonly Localizable[] | undefined, testId: string) => {
    if (!items?.length && !showMissing) return null;
    return (
      <div className="workflow-part" data-testid={testId}>
        <div className="muted workflow-label">{label}</div>
        {items?.length
          ? <ul>{items.map((item, index) => <li key={index}>{loc(item, lang)}</li>)}</ul>
          : <p className="muted workflow-missing">{t('flows.work.missing')}</p>}
      </div>
    );
  };
  return (
    <div className="workflow-grid">
      {list(t('flows.work.inputs'), stage.inputs, 'workflow-inputs')}
      {list(t('flows.work.activities'), stage.activities, 'workflow-activities')}
      {list(t('flows.work.outputs'), stage.outputs, 'workflow-outputs')}
      {list(t('flows.work.data'), stage.data, 'workflow-data')}
    </div>
  );
}

export function WorkflowSources({ stage, showMissing = false }: { stage: Stage; showMissing?: boolean }) {
  const { t } = useI18n();
  const sources = (stage.sourceIds ?? []).filter((id) => getEntity(id) || !loaded.byId.has(id));
  if (!sources.length && !showMissing) return null;
  return (
    <p className="muted" data-testid="workflow-sources">
      {t('flows.work.sources')}: {sources.length
        ? sources.map((id, index) => <span key={`${id}-${index}`}>{index > 0 && ', '}{getEntity(id) ? <EntityRef id={id} /> : id}</span>)
        : t('flows.work.noVisibleSources')}
    </p>
  );
}

export function WorkflowMap({ workflow }: { workflow: WorkflowExtension }) {
  const { t, lang } = useI18n();
  const route = useRoute();
  const mapId = useId();
  const nodeRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const stageParam = route.query.get('stage');
  const index = stageParam && /^[1-9]\d*$/.test(stageParam) ? Number(stageParam) - 1 : -1;
  const selected = Number.isSafeInteger(index) && index < workflow.stages.length ? index : -1;
  const indicesById = useMemo(() => {
    const indices = new Map<string, number[]>();
    workflow.stages.forEach((stage, i) => indices.set(stage.id, [...(indices.get(stage.id) ?? []), i]));
    return indices;
  }, [workflow]);

  const stageLabel = (i: number) => t('flows.work.stageLabel', { number: i + 1, name: loc(workflow.stages[i]!.name, lang) });
  const goTo = (i: number) => {
    replaceQuery({ stage: String(i + 1) });
    requestAnimationFrame(() => {
      nodeRefs.current[i]?.focus({ preventScroll: true });
      nodeRefs.current[i]?.scrollIntoView({ block: 'center', behavior: 'instant' });
    });
  };

  return (
    <div data-testid="workflow-map">
      <p className="muted">{t('flows.work.mapHint')}</p>
      <p className="muted workflow-map-note">{t('flows.work.mapNote')}</p>
      <ol className="workflow-map-list">
        {workflow.stages.map((stage, i) => {
          const expanded = selected === i;
          const hasTargets = stage.next.length > 0 || (stage.handoffTo?.length ?? 0) > 0;
          const unique = indicesById.get(stage.id)?.length === 1;
          const previous = unique
            ? workflow.stages.flatMap((source, sourceIndex) => source.next.includes(stage.id) ? [sourceIndex] : [])
            : [];
          const detailsId = `${mapId}-details-${i}`;
          return (
            <li className="workflow-map-row" key={`${stage.id}-${i}`} data-testid={`workflow-map-row-${i}`}>
              <div className="workflow-map-main">
                <button
                  type="button"
                  className="workflow-map-node"
                  ref={(node) => { nodeRefs.current[i] = node; }}
                  aria-expanded={expanded}
                  aria-controls={detailsId}
                  data-testid={`workflow-map-node-${i}`}
                  onClick={() => replaceQuery({ stage: expanded ? undefined : String(i + 1) })}
                >
                  <span className="workflow-map-number">{i + 1}</span>
                  <span className="workflow-map-node-content">
                    <span className="workflow-map-name">{loc(stage.name, lang)}</span>
                    <span className="workflow-map-field">{t('flows.work.team')}: {stage.team ? loc(stage.team, lang) : t('flows.work.missing')}</span>
                    <span className="workflow-map-field">
                      {t('flows.work.outputs')}: {stage.outputs.length ? stage.outputs.map((output) => loc(output, lang)).join(' / ') : t('flows.work.missing')}
                    </span>
                  </span>
                </button>
                <span className="workflow-map-arrow" aria-hidden="true">{hasTargets ? '→' : '—'}</span>
                <div className="workflow-map-targets">
                  {stage.next.length > 0 && (
                    <div>
                      <div className="muted workflow-label">{t('flows.work.mapNext')}</div>
                      <ul className="workflow-map-target-list">
                        {stage.next.map((id, targetIndex) => {
                          const matches = indicesById.get(id) ?? [];
                          return (
                            <li key={`${id}-${targetIndex}`}>
                              {matches.length === 1
                                ? <button type="button" className="workflow-map-link" aria-label={t('flows.work.goNext', { stage: stageLabel(matches[0]!) })} onClick={() => goTo(matches[0]!)}>{stageLabel(matches[0]!)}</button>
                                : <span className="workflow-map-unresolved">{t(matches.length ? 'flows.work.ambiguousTarget' : 'flows.work.unknownTarget', { id })}</span>}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                  {!!stage.handoffTo?.length && (
                    <div>
                      <div className="muted workflow-label">{t('flows.work.mapExternal')}</div>
                      <ul className="workflow-map-target-list">
                        {stage.handoffTo.map((team, teamIndex) => <li key={teamIndex} className="workflow-map-external">{loc(team, lang)}</li>)}
                      </ul>
                    </div>
                  )}
                  {!hasTargets && <span className="muted">{t('flows.work.noHandoff')}</span>}
                </div>
              </div>
              <div id={detailsId} hidden={!expanded}>
                {expanded && (
                  <section className="workflow-map-detail" aria-label={t('flows.work.details', { name: loc(stage.name, lang) })} data-testid={`workflow-map-details-${i}`}>
                    <div className="workflow-map-previous" data-testid="workflow-map-previous">
                      <strong>{t('flows.work.previous')}</strong>
                      {!unique ? <p className="muted">{t('flows.work.ambiguousPrevious')}</p>
                        : previous.length ? (
                          <ul className="workflow-map-target-list">
                            {previous.map((sourceIndex) => <li key={sourceIndex}><button type="button" className="workflow-map-link" aria-label={t('flows.work.goPrevious', { stage: stageLabel(sourceIndex) })} onClick={() => goTo(sourceIndex)}>{stageLabel(sourceIndex)}</button></li>)}
                          </ul>
                        ) : <p className="muted">{t('flows.work.noPrevious')}</p>}
                    </div>
                    <WorkflowFields stage={stage} showMissing />
                    <WorkflowSources stage={stage} showMissing />
                  </section>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
