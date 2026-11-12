import { useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Field, Input, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle, Select,
} from '@fluentui/react-components';
import { Add20Regular, ArrowUndo20Regular, Delete20Regular, Merge20Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { loadImportedPack, type ImportedPackMeta } from '../../data/packStore.ts';
import { RELATION_KINDS, useProjects, type Company, type Project, type ProjectRelation, type RelationKind } from '../../state/projects.ts';
import { circleLayout, sameIssueGroups, suggestRelations } from './projectRelations.ts';
import { mergeWarnings, packEvidence, type MergeAssessment, type PackEvidence } from './projectMerge.ts';
import { ProjectMergeDialog, useReasonText } from './ProjectMergeDialog.tsx';

const W = 640;
const H = 400;
const CX = W / 2;
const CY = H / 2;

const short = (s: string, max = 14) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

type EvidenceMap = ReadonlyMap<string, PackEvidence>;
type PackIndex = Record<string, ImportedPackMeta>;

/** KPIs, issues, solutions and data of each project's stored customer pack, re-read when a pack is saved or replaced. */
function usePackEvidence(projects: Project[], packs: PackIndex): EvidenceMap {
  const [evidence, setEvidence] = useState<EvidenceMap>(new Map());
  const withPack = projects.filter((p) => packs[p.id]);
  const key = withPack.map((p) => `${p.id}@${packs[p.id]!.importedAt}`).join('|');
  useEffect(() => {
    let alive = true;
    void Promise.all(withPack.map(async (p) => [p.id, packEvidence(await loadImportedPack(p.id).catch(() => null))] as const))
      .then((list) => { if (alive) setEvidence(new Map(list)); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return evidence;
}

/**
 * How the projects of one company relate. The company stays its own node in the centre (it is shared context, not a
 * project), each project hangs off it, and the relations people confirmed connect the projects: the same issue told
 * twice, one that must be solved first, or two that move together. Overlapping wording is offered as a hint only;
 * pairs whose business evidence says they may be one issue are flagged with the reasons and can be merged once agreed.
 */
export function ProjectRelationsPanel({ company, projects, relations, packs }: {
  company: Company;
  projects: Project[];
  relations: ProjectRelation[];
  packs: PackIndex;
}) {
  const { t, fmt } = useI18n();
  const reasonText = useReasonText();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [kind, setKind] = useState<RelationKind>('same');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [merging, setMerging] = useState<MergeAssessment | null>(null);
  const [merged, setMerged] = useState<string | null>(null);
  const dismissals = useProjects((s) => s.mergeDismissals);
  const evidence = usePackEvidence(projects, packs);
  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const flagged = useMemo(
    () => mergeWarnings(projects, relations, evidence, dismissals.filter((d) => d.companyId === company.id)),
    [projects, relations, evidence, dismissals, company.id],
  );
  const suggestions = useMemo(() => suggestRelations(projects, relations), [projects, relations]);
  const groups = useMemo(() => sameIssueGroups(projects, relations), [projects, relations]);
  const grouped = new Map(groups.flatMap((g, i) => g.map((id) => [id, i] as const)));
  const pos = new Map(projects.map((p, i) => [p.id, circleLayout(projects.length, CX, CY, projects.length === 1 ? 120 : 150)[i]!]));

  const add = (a: string, b: string, k: RelationKind, n?: string) => {
    const r = useProjects.getState().addRelation(a, b, k, n);
    if (r.ok) {
      setError(null);
      setNote('');
    } else setError(t(`proj.rel.err.${r.reason}`));
  };

  const kindText = (r: ProjectRelation) => t(`proj.rel.kind.${r.kind}`);
  const sentence = (r: ProjectRelation) => t(`proj.rel.sentence.${r.kind}`, { from: nameOf(r.from), to: nameOf(r.to) });

  return (
    <section className="proj-rel" aria-labelledby={`proj-rel-h-${company.id}`} data-testid="proj-rel">
      <h3 id={`proj-rel-h-${company.id}`} className="proj-h2">{t('proj.rel.title')}</h3>
      <p className="muted">{t('proj.rel.lead')}</p>
      <figure className="proj-rel-figure">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={t('proj.rel.diagramLabel', { company: company.name, projects: projects.length, relations: relations.length })}
          data-testid="proj-rel-diagram"
        >
          <defs>
            <marker id={`proj-rel-arrow-${company.id}`} viewBox="0 0 10 10" refX="22" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className="proj-rel-arrowhead" />
            </marker>
          </defs>
          {projects.map((p) => {
            const q = pos.get(p.id)!;
            return <line key={`own-${p.id}`} x1={CX} y1={CY} x2={q.x} y2={q.y} className="proj-rel-own" />;
          })}
          {relations.map((r) => {
            const a = pos.get(r.from);
            const b = pos.get(r.to);
            if (!a || !b) return null;
            return (
              <line
                key={r.id}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                className={`proj-rel-edge proj-rel-edge-${r.kind}`}
                markerEnd={r.kind === 'dependsOn' ? `url(#proj-rel-arrow-${company.id})` : undefined}
                data-kind={r.kind}
                data-testid="proj-rel-edge"
              >
                <title>{sentence(r)}</title>
              </line>
            );
          })}
          <g className="proj-rel-company" data-testid="proj-rel-company">
            <rect x={CX - 70} y={CY - 22} width={140} height={44} rx={6} />
            <text x={CX} y={CY + 5} textAnchor="middle">{short(company.name, 16)}</text>
            <title>{company.name}</title>
          </g>
          {projects.map((p) => {
            const q = pos.get(p.id)!;
            const right = q.x >= CX;
            const g = grouped.get(p.id);
            return (
              <g key={p.id} className="proj-rel-node" data-group={g ?? undefined}>
                <circle cx={q.x} cy={q.y} r={11} className={g === undefined ? undefined : 'proj-rel-node-same'} />
                <text x={q.x + (right ? 16 : -16)} y={q.y + 4} textAnchor={right ? 'start' : 'end'}>{short(p.name)}</text>
                <title>{p.brief?.purpose ? `${p.name}: ${p.brief.purpose}` : p.name}</title>
              </g>
            );
          })}
        </svg>
        <figcaption className="proj-rel-legend">
          <span><span className="proj-rel-key proj-rel-key-company" aria-hidden />{t('proj.rel.legend.company')}</span>
          <span><span className="proj-rel-key proj-rel-key-own" aria-hidden />{t('proj.rel.legend.own')}</span>
          {RELATION_KINDS.map((k) => <span key={k}><span className={`proj-rel-key proj-rel-key-${k}`} aria-hidden />{t(`proj.rel.kind.${k}`)}</span>)}
        </figcaption>
      </figure>

      {groups.length > 0 && (
        <MessageBar intent="warning" data-testid="proj-rel-groups">
          <MessageBarBody>
            {t('proj.rel.groups')}
            <ul>{groups.map((g) => <li key={g.join('|')}>{g.map(nameOf).join(t('ai.listSep'))}</li>)}</ul>
          </MessageBarBody>
        </MessageBar>
      )}

      {merged && <MessageBar intent="success" role="status" data-testid="proj-merge-done"><MessageBarBody>{merged}</MessageBarBody></MessageBar>}
      {(flagged.warnings.length > 0 || flagged.dismissed.length > 0) && (
        <section className="proj-merge" aria-labelledby={`proj-merge-h-${company.id}`} data-testid="proj-merge-warnings">
          <h4 id={`proj-merge-h-${company.id}`} className="proj-h3">{t('proj.merge.warnTitle')}</h4>
          <p className="muted">{t('proj.merge.warnLead')}</p>
          {flagged.warnings.map((w) => (
            <MessageBar key={`${w.a}|${w.b}`} intent="warning" layout="multiline" data-testid="proj-merge-warning" data-pair={`${nameOf(w.a)}|${nameOf(w.b)}`}>
              <MessageBarBody>
                <MessageBarTitle>{t('proj.merge.warning', { a: nameOf(w.a), b: nameOf(w.b), score: fmt.percent(w.score) })}</MessageBarTitle>
                <ul className="proj-merge-reasons" aria-label={t('proj.merge.reasonsLabel')}>
                  {w.reasons.map((r) => <li key={r.kind}>{reasonText(r)}</li>)}
                </ul>
              </MessageBarBody>
              <MessageBarActions>
                <Button size="small" appearance="primary" icon={<Merge20Regular />} onClick={() => { setMerged(null); setMerging(w); }} data-testid="proj-merge-open">
                  {t('proj.merge.open')}
                </Button>
                <Button size="small" onClick={() => useProjects.getState().dismissMergeWarning(w.a, w.b, w.score)} data-testid="proj-merge-dismiss">
                  {t('proj.merge.dismiss')}
                </Button>
              </MessageBarActions>
            </MessageBar>
          ))}
          {flagged.dismissed.length > 0 && (
            <div data-testid="proj-merge-dismissed">
              <p className="muted">{t('proj.merge.dismissedLead')}</p>
              <ul>
                {flagged.dismissed.map(({ dismissal }) => (
                  <li key={dismissal.id} className="proj-row">
                    <span>{t('proj.merge.dismissedItem', { a: nameOf(dismissal.a), b: nameOf(dismissal.b), date: fmt.date(dismissal.at.slice(0, 10)) })}</span>
                    <Button size="small" icon={<ArrowUndo20Regular />} onClick={() => useProjects.getState().restoreMergeWarning(dismissal.id)} data-testid="proj-merge-restore">
                      {t('proj.merge.restore')}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
      {merging && (
        <ProjectMergeDialog
          key={`${merging.a}|${merging.b}`}
          assessment={merging}
          projects={projects}
          relations={relations}
          packs={packs}
          onClose={() => setMerging(null)}
          onMerged={setMerged}
        />
      )}

      <table className="data-table" data-testid="proj-rel-table">
        <caption>{t('proj.rel.tableCaption', { company: company.name })}</caption>
        <thead>
          <tr>
            <th scope="col">{t('proj.rel.col.relation')}</th>
            <th scope="col">{t('proj.rel.col.kind')}</th>
            <th scope="col">{t('proj.rel.col.note')}</th>
            <th scope="col">{t('proj.projects.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {relations.length === 0 && <tr><td colSpan={4} className="empty">{t('proj.rel.none')}</td></tr>}
          {relations.map((r) => (
            <tr key={r.id} data-kind={r.kind}>
              <th scope="row">{sentence(r)}</th>
              <td><Badge appearance="tint" className={`proj-rel-badge-${r.kind}`}>{kindText(r)}</Badge></td>
              <td className="proj-prewrap">{r.note ?? '—'}</td>
              <td>
                <Button size="small" icon={<Delete20Regular />} onClick={() => useProjects.getState().removeRelation(r.id)} aria-label={t('proj.rel.remove', { relation: sentence(r) })}>{t('proj.delete')}</Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {projects.length < 2 ? <p className="muted">{t('proj.rel.needTwo')}</p> : (
        <form className="proj-form-row" onSubmit={(e) => { e.preventDefault(); add(from, to, kind, note); }} data-testid="proj-rel-form">
          <Field label={t('proj.rel.from')}>
            <Select value={from} onChange={(_, d) => setFrom(d.value)} data-testid="proj-rel-from">
              <option value="">{t('proj.rel.choose')}</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label={t('proj.rel.col.kind')}>
            <Select value={kind} onChange={(_, d) => setKind(d.value as RelationKind)} data-testid="proj-rel-kind">
              {RELATION_KINDS.map((k) => <option key={k} value={k}>{t(`proj.rel.kindVerb.${k}`)}</option>)}
            </Select>
          </Field>
          <Field label={t('proj.rel.to')}>
            <Select value={to} onChange={(_, d) => setTo(d.value)} data-testid="proj-rel-to">
              <option value="">{t('proj.rel.choose')}</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label={t('proj.rel.col.note')} className="grow">
            <Input value={note} onChange={(_, d) => setNote(d.value)} placeholder={t('proj.rel.notePlaceholder')} data-testid="proj-rel-note" />
          </Field>
          <Button type="submit" appearance="primary" icon={<Add20Regular />} disabled={!from || !to} data-testid="proj-rel-add">{t('proj.rel.add')}</Button>
        </form>
      )}
      {error && <MessageBar intent="error" role="alert" data-testid="proj-rel-error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}

      {suggestions.length > 0 && (
        <div className="proj-rel-suggest" data-testid="proj-rel-suggest">
          <h4 className="proj-h3">{t('proj.rel.suggestTitle')}</h4>
          <p className="muted">{t('proj.rel.suggestLead')}</p>
          <ul>
            {suggestions.map((s) => (
              <li key={`${s.from}|${s.to}`} data-testid="proj-rel-suggestion">
                <span>
                  {t('proj.rel.suggestion', { a: nameOf(s.from), b: nameOf(s.to), score: fmt.percent(s.score) })}
                  {s.shared.length > 0 && <span className="muted">{` ${t('proj.rel.sharedTerms', { terms: s.shared.join(t('ai.listSep')) })}`}</span>}
                </span>
                <span className="proj-row">
                  <Button size="small" onClick={() => add(s.from, s.to, 'same')}>{t('proj.rel.asSame')}</Button>
                  <Button size="small" onClick={() => add(s.from, s.to, 'correlated')}>{t('proj.rel.asCorrelated')}</Button>
                  <Button size="small" onClick={() => add(s.from, s.to, 'dependsOn')}>{t('proj.rel.asDepends', { a: short(nameOf(s.from)), b: short(nameOf(s.to)) })}</Button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
