import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Badge, Button, Select, ToggleButton } from '@fluentui/react-components';
import { ArrowUpload20Regular, Delete20Regular, TaskListAdd20Regular } from '@fluentui/react-icons';
import { getEntity } from '../../data/pack.ts';
import { useI18n } from '../../i18n/index.ts';
import { PERSONA_VIEWS, personaLabel, type PersonaView } from '../../state/personas.ts';
import { loc } from '../../state/text.ts';
import { EntityRef } from '../../ui/EntityRef.tsx';
import { PageHeader, Panel } from '../../ui/Panel.tsx';
import {
  catalogForScope, countByCategory, enrichEntities, MAX_CATALOG_BYTES, MAX_CATALOG_ITEMS, parseCatalogFile, RECON_CATEGORIES, reconcile,
  useCatalogImport, type ReconCategory, type ReconRow, type RowError,
} from './catalog.ts';
import { buildClusters, deriveDataModel, isSimplified, linkKey, totalColumns, VIEWER_MAX_COLUMNS, VIEWER_MAX_ENTITIES, ZOOM_FOR, type DataEntity } from './catalogModel.ts';
import { DataViewer } from './DataViewer.tsx';
import { addMissingToTodos, toggleLink, useCatalogLinks, useTodos } from './links.ts';
import { useUseCases, type UseCase } from './store.ts';
import { hasWebGL } from './viewerLayout.ts';
import './usecases.css';

const PERSONA_ZOOM: Record<PersonaView, number> = { executive: ZOOM_FOR.clusters, business: ZOOM_FOR.entities, it: ZOOM_FOR.columns, field: ZOOM_FOR.entities };
const MAX_SOURCE_REFS = 10;

/** Non-colour cue for each reconciliation category (NFR-A11Y). */
function CategoryMark({ category }: { category: ReconCategory }) {
  const d = {
    match: 'M3 8 L7 12 L13 4',
    difference: 'M8 2 L14 14 L2 14 Z',
    basOnly: 'M2 2 H14 V14 H2 Z',
    catalogOnly: 'M8 2 A6 6 0 1 1 7.99 2 Z',
  }[category];
  return (
    <svg className={`uc-cat-mark uc-cat-${category}`} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}

/** /catalog — FR-159〜162, FR-169〜172: data entities, entity × use case links, company catalog reconciliation, data viewer. */
export function CatalogScreen() {
  const { t, lang, fmt } = useI18n();
  const useCases = useUseCases((s) => s.value);
  const storedCatalog = useCatalogImport((s) => s.value);
  const scope = useCatalogImport((s) => s.scope);
  const catalog = useMemo(() => catalogForScope(storedCatalog, scope), [storedCatalog, scope]);
  const setCatalog = useCatalogImport((s) => s.set);
  const explicit = useCatalogLinks((s) => s.value);
  const setExplicit = useCatalogLinks((s) => s.set);
  const todos = useTodos((s) => s.value);
  const setTodos = useTodos((s) => s.set);
  const [persona, setPersona] = useState<PersonaView>('business');
  const [layout, setLayout] = useState<'side' | 'stacked'>('side');
  const [clusterBy, setClusterBy] = useState<'usecase' | 'domain'>('usecase');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<ReconCategory | 'all'>('all');
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string; rowErrors: RowError[] } | null>(null);
  const [todoMsg, setTodoMsg] = useState('');
  const fileId = useId();
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const webgl = useMemo(() => hasWebGL(), []);

  const model = useMemo(() => deriveDataModel(useCases), [useCases]);
  const rows = useMemo(() => reconcile(model.entities, catalog?.items ?? []), [model, catalog]);
  const entities = useMemo(() => enrichEntities(model.entities, rows), [model, rows]);
  const links = useMemo(() => new Set([...model.derivedLinks, ...explicit.map((x) => linkKey(x.entityId, x.useCaseId))]), [model, explicit]);
  const clusters = useMemo(() => buildClusters(entities, links, useCases, clusterBy), [entities, links, useCases, clusterBy]);
  const columnCount = totalColumns(entities);
  const simplified = isSimplified(entities.length, columnCount);
  const counts = countByCategory(rows);
  const categoryOf = useMemo(() => new Map(rows.filter((r) => r.entity).map((r) => [r.entity!.id, r.category] as const)), [rows]);
  const catalogOnly = useMemo(() => rows.filter((r) => r.category === 'catalogOnly' && r.item).map((r) => r.item!), [rows]);
  const ucOf = (entityId: string): UseCase[] => useCases.filter((u) => links.has(linkKey(entityId, u.id)));
  const selected = selectedId ? entities.find((e) => e.id === selectedId) : undefined;

  useEffect(() => {
    if (selectedId) rowRefs.current.get(selectedId)?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedId]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_CATALOG_BYTES) {
      setImportMsg({ ok: false, text: t('uc.import.error.tooLarge', { mb: MAX_CATALOG_BYTES / 1024 / 1024 }), rowErrors: [] });
      return;
    }
    const result = parseCatalogFile(file.name, await file.text(), file.size);
    if (!result.ok) {
      setImportMsg({ ok: false, text: t(`uc.import.error.${result.error}`, { mb: MAX_CATALOG_BYTES / 1024 / 1024, max: MAX_CATALOG_ITEMS }), rowErrors: result.rowErrors });
      return;
    }
    setCatalog(result.catalog);
    setFilter('all');
    setImportMsg({ ok: true, text: t('uc.import.done', { n: result.catalog.items.length, skipped: result.rowErrors.length, file: file.name }), rowErrors: result.rowErrors });
  };

  const addTodos = () => {
    const missing = rows.filter((r) => r.category === 'basOnly' && r.entity).map((r) => ({ entity: r.entity!, useCases: ucOf(r.entity!.id) }));
    const { next, added } = addMissingToTodos(todos, missing);
    if (added > 0) setTodos(next);
    setTodoMsg(added > 0 ? t('uc.todo.added', { n: added }) : t('uc.todo.none'));
  };

  const catalogTodos = todos.filter((x) => x.key.startsWith('catalog:'));
  const shownRows = rows.filter((r) => filter === 'all' || r.category === filter);
  const showDescription = persona !== 'field';
  const showColumns = persona !== 'executive';

  const reasonText = (r: ReconRow) =>
    r.reasons.length === 0 ? (r.by ? t(`uc.recon.by.${r.by}`) : '—') : r.reasons.map((x) => t(`uc.recon.reason.${x}`)).join(', ');

  const viewer = (
    <Panel title={t('uc.viewer.title')} rationale="uc.viewer.rationale" testId="uc-viewer-panel">
      <DataViewer
        key={persona}
        entities={entities}
        relations={model.relations}
        clusters={clusters}
        selectedId={selectedId}
        onSelect={setSelectedId}
        initialZoom={PERSONA_ZOOM[persona]}
        simplified={simplified}
        webgl={webgl}
      />
    </Panel>
  );

  const table = (
    <Panel title={t('uc.entities.title', { n: entities.length })} rationale="uc.entities.rationale" testId="uc-entities">
      <div className="table-scroll uc-entity-scroll">
        <table className="data-table compact">
          <caption className="visually-hidden">{t('uc.entities.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('uc.entities.col.name')}</th>
              {showDescription && <th scope="col">{t('uc.entities.col.description')}</th>}
              {showColumns && <th scope="col">{t('uc.entities.col.columns')}</th>}
              <th scope="col">{t('uc.entities.col.usecases')}</th>
              <th scope="col">{t('uc.entities.col.catalog')}</th>
            </tr>
          </thead>
          <tbody>
            {entities.map((e) => {
              const sel = e.id === selectedId;
              const cat = catalog ? categoryOf.get(e.id) : undefined;
              return (
                <tr key={e.id} ref={(el) => { if (el) rowRefs.current.set(e.id, el); else rowRefs.current.delete(e.id); }} className={sel ? 'uc-row-selected' : undefined} data-entity-id={e.id} data-selected={sel ? 'true' : 'false'}>
                  <td>
                    <Button size="small" appearance={sel ? 'primary' : 'subtle'} aria-pressed={sel} onClick={() => setSelectedId(sel ? null : e.id)}>
                      {loc(e.name, lang)}
                    </Button>
                  </td>
                  {showDescription && <td>{loc(e.description, lang)}</td>}
                  {showColumns && <td>{fmt.integer(e.columns.length)}</td>}
                  <td>{fmt.integer(ucOf(e.id).length)}</td>
                  <td>{cat ? <span className="uc-cat"><CategoryMark category={cat} />{t(`uc.recon.cat.${cat}`)}</span> : t('uc.entities.notImported')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {catalogOnly.length > 0 && (
        <div className="table-scroll uc-entity-scroll" data-testid="uc-catalog-items" role="region" tabIndex={0} aria-label={t('uc.entities.fromCatalogCaption')}>
          <p className="muted">{t('uc.entities.fromCatalog', { n: catalogOnly.length })}</p>
          <table className="data-table compact">
            <caption className="visually-hidden">{t('uc.entities.fromCatalogCaption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('uc.entities.col.name')}</th>
                <th scope="col">{t('uc.entities.col.domain')}</th>
                <th scope="col">{t('uc.entities.col.description')}</th>
                <th scope="col">{t('uc.entities.col.columns')}</th>
              </tr>
            </thead>
            <tbody>
              {catalogOnly.map((it, i) => (
                <tr key={`${it.id ?? it.name}-${i}`}>
                  <td>{it.url && /^https:\/\//.test(it.url) ? <a href={it.url} target="_blank" rel="noreferrer noopener">{it.name}</a> : it.name}</td>
                  <td>{it.domain ?? ''}</td>
                  <td>{it.description ?? ''}</td>
                  <td>{fmt.integer(it.columns?.length ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );

  return (
    <div className="screen uc-screen">
      <PageHeader title={t('uc.nav.catalog')} subtitle={t('uc.catalog.subtitle')} />
      <div className="toolbar uc-catalog-tools">
        <div className="uc-filter">
          <label htmlFor="uc-cat-persona">{t('uc.catalog.persona')}</label>
          <Select id="uc-cat-persona" value={persona} onChange={(_, d) => setPersona(d.value as PersonaView)}>
            {PERSONA_VIEWS.map((p) => <option key={p} value={p}>{t(personaLabel(p))}</option>)}
          </Select>
        </div>
        <div className="uc-filter">
          <label htmlFor="uc-cat-cluster">{t('uc.catalog.clusterBy')}</label>
          <Select id="uc-cat-cluster" value={clusterBy} onChange={(_, d) => setClusterBy(d.value as 'usecase' | 'domain')}>
            <option value="usecase">{t('uc.catalog.cluster.usecase')}</option>
            <option value="domain">{t('uc.catalog.cluster.domain')}</option>
          </Select>
        </div>
        <div role="group" aria-label={t('uc.catalog.layout')} className="toggle-group">
          <ToggleButton size="small" checked={layout === 'side'} onClick={() => setLayout('side')}>{t('uc.catalog.layout.side')}</ToggleButton>
          <ToggleButton size="small" checked={layout === 'stacked'} onClick={() => setLayout('stacked')}>{t('uc.catalog.layout.stacked')}</ToggleButton>
        </div>
      </div>
      <p className="muted">{t(`uc.catalog.personaHint.${persona}`)}</p>
      <ul className="uc-summary" aria-label={t('uc.catalog.summary')}>
        <li><strong>{fmt.integer(entities.length)}</strong> {t('uc.catalog.sum.entities')}</li>
        <li><strong>{fmt.integer(columnCount)}</strong> {t('uc.catalog.sum.columns')}</li>
        <li><strong>{fmt.integer(useCases.length)}</strong> {t('uc.catalog.sum.usecases')}</li>
        <li><strong>{fmt.integer(clusters.length)}</strong> {t('uc.catalog.sum.clusters')}</li>
      </ul>
      {simplified && <p className="uc-notice" role="note">{t('uc.viewer.simplified', { entities: VIEWER_MAX_ENTITIES, columns: VIEWER_MAX_COLUMNS })}</p>}

      <div className={`uc-catalog-grid ${layout}`}>
        {viewer}
        {table}
      </div>

      {selected && <EntityDetail entity={selected} useCases={ucOf(selected.id)} derived={(uc) => model.derivedLinks.has(linkKey(selected.id, uc.id))} category={catalog ? categoryOf.get(selected.id) : undefined} />}

      <Panel title={t('uc.matrix.title')} rationale="uc.matrix.rationale" testId="uc-matrix">
        {useCases.length === 0 ? <p className="muted">{t('uc.matrix.noUseCases')}</p> : (
          <div className="table-scroll">
            <table className="data-table compact uc-matrix">
              <caption className="visually-hidden">{t('uc.matrix.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('uc.entities.col.name')}</th>
                  {useCases.map((u) => <th key={u.id} scope="col" className="uc-matrix-head">{loc(u.name, lang)}</th>)}
                </tr>
              </thead>
              <tbody>
                {entities.map((e) => (
                  <tr key={e.id}>
                    <th scope="row">{loc(e.name, lang)}</th>
                    {useCases.map((u) => {
                      const derived = model.derivedLinks.has(linkKey(e.id, u.id));
                      const on = explicit.some((x) => x.entityId === e.id && x.useCaseId === u.id);
                      if (derived) return <td key={u.id} className="uc-cell-derived"><span className="uc-derived-mark" aria-hidden="true">◆</span>{t('uc.matrix.derived')}</td>;
                      const vars = { entity: loc(e.name, lang), usecase: loc(u.name, lang) };
                      return (
                        <td key={u.id}>
                          <Button
                            size="small"
                            appearance={on ? 'primary' : 'subtle'}
                            aria-pressed={on}
                            aria-label={on ? t('uc.matrix.unlinkLabel', vars) : t('uc.matrix.linkLabel', vars)}
                            data-link={`${e.id}|${u.id}`}
                            onClick={() => setExplicit((l) => toggleLink(l, e.id, u.id))}
                          >
                            {on ? t('uc.matrix.linked') : t('uc.matrix.link')}
                          </Button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted">{t('uc.matrix.legend')}</p>
      </Panel>

      <Panel title={t('uc.import.title')} rationale="uc.import.rationale" testId="uc-import">
        <p className="muted">{t('uc.import.hint', { mb: MAX_CATALOG_BYTES / 1024 / 1024, max: MAX_CATALOG_ITEMS })}</p>
        <div className="toolbar">
          <label htmlFor={fileId} className="uc-file-label"><ArrowUpload20Regular aria-hidden="true" />{t('uc.import.choose')}</label>
          <input
            id={fileId}
            type="file"
            accept=".json,.csv,application/json,text/csv"
            data-testid="uc-import-file"
            className="uc-file-input"
            onChange={(e) => {
              const input = e.currentTarget;
              void onFile(input.files?.[0]).finally(() => { input.value = ''; });
            }}
          />
          {catalog && <Button icon={<Delete20Regular />} onClick={() => { setCatalog(null); setImportMsg(null); }}>{t('uc.import.clear')}</Button>}
        </div>
        <div role="status" aria-live="polite" data-testid="uc-import-status">
          {importMsg && <p className={importMsg.ok ? 'uc-ok' : 'uc-error'}>{importMsg.text}</p>}
          {importMsg && importMsg.rowErrors.length > 0 && (
            <ul className="uc-row-errors">
              {importMsg.rowErrors.slice(0, 20).map((r) => <li key={r.row}>{t('uc.import.rowError', { row: r.row, field: r.field })}</li>)}
            </ul>
          )}
        </div>
        {catalog ? (
          <>
            <p>{t('uc.import.current', { file: catalog.fileName === 'pack' ? t('uc.import.fromPack') : catalog.fileName, n: catalog.items.length, date: fmt.date(catalog.importedAt.slice(0, 10)) })}</p>
            <div className="uc-recon-cards" role="group" aria-label={t('uc.recon.filter')}>
              <ToggleButton checked={filter === 'all'} onClick={() => setFilter('all')}>{t('uc.recon.all', { n: rows.length })}</ToggleButton>
              {RECON_CATEGORIES.map((c) => (
                <ToggleButton key={c} checked={filter === c} onClick={() => setFilter(c)} data-testid={`uc-recon-${c}`} data-count={counts[c]} icon={<CategoryMark category={c} />}>
                  {t('uc.recon.count', { name: t(`uc.recon.cat.${c}`), n: counts[c] })}
                </ToggleButton>
              ))}
            </div>
            <div className="table-scroll" tabIndex={0} role="region" aria-label={t('uc.recon.caption')}>
              <table className="data-table compact">
                <caption className="visually-hidden">{t('uc.recon.caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('uc.recon.col.category')}</th>
                    <th scope="col">{t('uc.recon.col.entity')}</th>
                    <th scope="col">{t('uc.recon.col.item')}</th>
                    <th scope="col">{t('uc.recon.col.reason')}</th>
                    <th scope="col">{t('uc.recon.col.source')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shownRows.map((r, i) => (
                    <tr key={i} data-category={r.category}>
                      <td><span className="uc-cat"><CategoryMark category={r.category} />{t(`uc.recon.cat.${r.category}`)}</span></td>
                      <td>{r.entity ? loc(r.entity.name, lang) : '—'}</td>
                      <td>{r.item ? (r.item.id ? `${r.item.name} (${r.item.id})` : r.item.name) : '—'}</td>
                      <td>{reasonText(r)}</td>
                      <td className="uc-url">{r.item?.url ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted">{t('uc.import.urlNote')}</p>
          </>
        ) : <p className="muted">{t('uc.import.none')}</p>}

        <h3 className="subhead">{t('uc.todo.title')}</h3>
        <div className="toolbar">
          <Button icon={<TaskListAdd20Regular />} disabled={!catalog || counts.basOnly === 0} onClick={addTodos}>{t('uc.todo.add', { n: catalog ? counts.basOnly : 0 })}</Button>
          <span role="status" data-testid="uc-todo-status">{todoMsg}</span>
        </div>
        <ul className="uc-todo-list" data-testid="uc-todos" data-count={catalogTodos.length}>
          {catalogTodos.map((x) => (
            <li key={x.id}>
              <strong>{loc(x.name, lang)}</strong>
              <span className="muted">{loc(x.description, lang)}</span>
            </li>
          ))}
        </ul>
        {catalogTodos.length === 0 && <p className="muted">{t('uc.todo.empty')}</p>}
      </Panel>
    </div>
  );
}

function EntityDetail({ entity, useCases, derived, category }: { entity: DataEntity; useCases: UseCase[]; derived: (uc: UseCase) => boolean; category?: ReconCategory }) {
  const { t, lang } = useI18n();
  const refs = entity.sourceIds.filter((id) => getEntity(id));
  return (
    <Panel title={t('uc.detail.entity', { name: loc(entity.name, lang) })} testId="uc-entity-detail">
      <p>{loc(entity.description, lang)}</p>
      <div className="grid-2">
        <section aria-label={t('uc.detail.columns')}>
          <h3 className="subhead">{t('uc.detail.columns')}</h3>
          {entity.columns.length === 0 ? <p className="muted">{t('uc.detail.noColumns')}</p> : (
            <ul className="uc-columns">
              {entity.columns.map((c) => (
                <li key={c.name}><code>{c.name}</code> <Badge appearance="outline" size="small">{t(`uc.detail.colSource.${c.source}`)}</Badge></li>
              ))}
            </ul>
          )}
        </section>
        <section aria-label={t('uc.detail.links')}>
          <h3 className="subhead">{t('uc.detail.links')}</h3>
          {useCases.length === 0 ? <p className="muted">{t('uc.detail.noLinks')}</p> : (
            <ul>
              {useCases.map((u) => <li key={u.id}>{loc(u.name, lang)} <Badge appearance="tint" size="small">{derived(u) ? t('uc.matrix.derived') : t('uc.matrix.explicit')}</Badge></li>)}
            </ul>
          )}
          {category && <p>{t('uc.detail.catalog', { cat: t(`uc.recon.cat.${category}`) })}</p>}
          {entity.domain && <p>{t('uc.detail.domain', { domain: entity.domain })}</p>}
        </section>
      </div>
      {refs.length > 0 && (
        <>
          <h3 className="subhead">{t('uc.detail.sources', { n: refs.length })}</h3>
          <ul className="ref-list">{refs.slice(0, MAX_SOURCE_REFS).map((id) => <li key={id}><EntityRef id={id} /></li>)}</ul>
          {refs.length > MAX_SOURCE_REFS && <p className="muted">{t('uc.detail.moreSources', { n: refs.length - MAX_SOURCE_REFS })}</p>}
        </>
      )}
    </Panel>
  );
}
