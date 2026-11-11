import { useMemo, useState } from 'react';
import { Badge, Button, Field, Input, MessageBar, MessageBarBody, Select } from '@fluentui/react-components';
import { Add20Regular, Delete20Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { RELATION_KINDS, useProjects, type Company, type Project, type ProjectRelation, type RelationKind } from '../../state/projects.ts';
import { circleLayout, sameIssueGroups, suggestRelations } from './projectRelations.ts';

const W = 640;
const H = 400;
const CX = W / 2;
const CY = H / 2;

const short = (s: string, max = 14) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * How the projects of one company relate. The company stays its own node in the centre (it is shared context, not a
 * project), each project hangs off it, and the relations people confirmed connect the projects: the same issue told
 * twice, one that must be solved first, or two that move together. Overlapping wording is offered as a hint only.
 */
export function ProjectRelationsPanel({ company, projects, relations }: { company: Company; projects: Project[]; relations: ProjectRelation[] }) {
  const { t, fmt } = useI18n();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [kind, setKind] = useState<RelationKind>('same');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
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
