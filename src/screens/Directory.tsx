import { useMemo } from 'react';
import { Button, Checkbox, Input, Label, Select, Tab, TabList } from '@fluentui/react-components';
import { Search24Regular, LockClosed16Regular } from '@fluentui/react-icons';
import { entitiesOf, getEntity, loaded, regionName } from '../data/pack.ts';
import type { Entity } from '../data/schema.ts';
import { useI18n, type MessageKey } from '../i18n/index.ts';
import { useSettings } from '../state/settings.ts';
import { hrefFor, replaceQuery, useRoute } from '../state/router.ts';
import { PageHeader, Panel } from '../ui/Panel.tsx';
import { EntityRef } from '../ui/EntityRef.tsx';
import { isHidden } from '../ui/cardSpecs.ts';

type TabKey = 'people' | 'customers' | 'products' | 'deals' | 'invoices';
const TABS: TabKey[] = ['people', 'customers', 'products', 'deals', 'invoices'];

interface Column {
  header: MessageKey;
  cell: (e: Entity) => React.ReactNode;
  internal?: boolean;
  numeric?: boolean;
}

function useTabConfig(tab: TabKey) {
  const { t, tx, fmt } = useI18n();
  return useMemo(() => {
    const ref = (id: string, image = false) => <EntityRef id={id} image={image} />;
    switch (tab) {
      case 'people': return {
        rows: entitiesOf('person') as Entity[],
        filterLabel: 'field.site' as MessageKey,
        filterOptions: entitiesOf('site').filter((s) => entitiesOf('person').some((p) => p.siteId === s.id)).map((s) => ({ value: s.id, label: tx(s.name) })),
        filterValue: (e: Entity) => (e.kind === 'person' ? e.siteId : ''),
        columns: [
          { header: 'field.name', cell: (e) => ref(e.id, true) },
          { header: 'field.role', cell: (e) => (e.kind === 'person' ? tx(e.role) : '') },
          { header: 'field.ageBand', cell: (e) => (e.kind === 'person' ? t(`ageBand.${e.ageBand}`) : '') },
          { header: 'field.site', cell: (e) => (e.kind === 'person' ? ref(e.siteId) : '') },
        ] as Column[],
      };
      case 'customers': return {
        rows: entitiesOf('customer') as Entity[],
        filterLabel: 'field.region' as MessageKey,
        filterOptions: loaded.pack.regions.map((r) => ({ value: r.id, label: tx(r.name) })),
        filterValue: (e: Entity) => (e.kind === 'customer' ? e.regionId : ''),
        columns: [
          { header: 'field.name', cell: (e) => ref(e.id, true) },
          { header: 'field.industry', cell: (e) => (e.kind === 'customer' ? tx(e.industry) : '') },
          { header: 'field.region', cell: (e) => (e.kind === 'customer' ? tx(regionName(e.regionId)!) : '') },
          { header: 'field.deals', numeric: true, cell: (e) => fmt.integer(entitiesOf('deal').filter((d) => d.customerId === e.id).length) },
        ] as Column[],
      };
      case 'products': return {
        rows: entitiesOf('product') as Entity[],
        filterLabel: 'field.madeAt' as MessageKey,
        filterOptions: entitiesOf('site').filter((s) => s.role === 'plant').map((s) => ({ value: s.id, label: tx(s.name) })),
        filterValue: (e: Entity) => (e.kind === 'product' ? e.siteId : ''),
        columns: [
          { header: 'field.name', cell: (e) => ref(e.id, true) },
          { header: 'field.category', cell: (e) => (e.kind === 'product' ? tx(e.category) : '') },
          { header: 'field.madeAt', cell: (e) => (e.kind === 'product' ? ref(e.siteId) : '') },
          { header: 'field.unitPrice', numeric: true, internal: true, cell: (e) => (e.kind === 'product' ? fmt.yen(e.unitPriceJpy) : '') },
        ] as Column[],
      };
      case 'deals': return {
        rows: entitiesOf('deal') as Entity[],
        filterLabel: 'field.stage' as MessageKey,
        filterOptions: (['lead', 'proposal', 'negotiation', 'won', 'delivered'] as const).map((s) => ({ value: s, label: t(`stage.${s}`) })),
        filterValue: (e: Entity) => (e.kind === 'deal' ? e.stage : ''),
        columns: [
          { header: 'field.name', cell: (e) => ref(e.id) },
          { header: 'field.customer', cell: (e) => (e.kind === 'deal' ? ref(e.customerId, true) : '') },
          { header: 'field.stage', cell: (e) => (e.kind === 'deal' ? t(`stage.${e.stage}`) : '') },
          { header: 'field.value', numeric: true, internal: true, cell: (e) => (e.kind === 'deal' ? fmt.yenCompact(e.valueJpy) : '') },
          { header: 'field.closeDate', cell: (e) => (e.kind === 'deal' ? fmt.date(e.closeDate) : '') },
          { header: 'field.owner', cell: (e) => (e.kind === 'deal' ? ref(e.ownerId, true) : '') },
        ] as Column[],
      };
      case 'invoices': return {
        rows: entitiesOf('invoice') as Entity[],
        filterLabel: 'field.status' as MessageKey,
        filterOptions: (['draft', 'sent', 'paid', 'overdue'] as const).map((s) => ({ value: s, label: t(`invoiceStatus.${s}`) })),
        filterValue: (e: Entity) => (e.kind === 'invoice' ? e.status : ''),
        columns: [
          { header: 'field.name', cell: (e) => ref(e.id) },
          { header: 'field.deliverable', cell: (e) => (e.kind === 'invoice' ? ref(e.deliverableId) : '') },
          { header: 'field.amount', numeric: true, internal: true, cell: (e) => (e.kind === 'invoice' ? fmt.yen(e.amountJpy) : '') },
          { header: 'field.issuedDate', cell: (e) => (e.kind === 'invoice' ? fmt.date(e.issuedDate) : '') },
          { header: 'field.status', cell: (e) => (e.kind === 'invoice' ? t(`invoiceStatus.${e.status}`) : '') },
        ] as Column[],
      };
    }
  }, [tab, t, tx, fmt]);
}

export function Directory() {
  const { t, tx } = useI18n();
  const audience = useSettings((s) => s.audience);
  const route = useRoute();
  const tab = (TABS as string[]).includes(route.query.get('tab') ?? '') ? (route.query.get('tab') as TabKey) : 'people';
  const q = route.query.get('q') ?? '';
  const filter = route.query.get('f') ?? '';
  const selected = new Set((route.query.get('sel') ?? '').split(',').filter(Boolean));
  const cfg = useTabConfig(tab);

  const needle = q.trim().toLowerCase();
  const visible = cfg.rows.filter((e) => !isHidden(e, audience));
  const hiddenCount = cfg.rows.length - visible.length;
  const rows = visible.filter((e) => {
    if (filter && cfg.filterValue(e) !== filter) return false;
    if (!needle) return true;
    return [e.name.ja, e.name.en, e.description.ja, e.description.en].some((s) => s.toLowerCase().includes(needle));
  });

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id); else next.delete(id);
    replaceQuery({ sel: [...next].join(',') || undefined });
  };
  const firstSelected = [...selected].find((id) => getEntity(id));

  return (
    <div className="screen screen-directory">
      <PageHeader title={t('directory.title')} subtitle={t('directory.subtitle')} />
      <TabList selectedValue={tab} onTabSelect={(_, d) => replaceQuery({ tab: String(d.value), f: undefined, sel: undefined })} aria-label={t('directory.tabs')}>
        {TABS.map((k) => <Tab key={k} value={k}>{t(`directory.tab.${k}`)}</Tab>)}
      </TabList>
      <Panel title={t(`directory.tab.${tab}`)} rationale="visual.table" testId="directory-panel">
        <div className="toolbar" role="search">
          <div className="control grow">
            <Label htmlFor="dir-search">{t('directory.search')}</Label>
            <Input id="dir-search" contentBefore={<Search24Regular />} value={q} onChange={(_, d) => replaceQuery({ q: d.value })} placeholder={t('directory.searchPlaceholder')} />
          </div>
          <div className="control">
            <Label htmlFor="dir-filter">{t(cfg.filterLabel)}</Label>
            <Select id="dir-filter" value={filter} onChange={(_, d) => replaceQuery({ f: d.value })}>
              <option value="">{t('directory.all')}</option>
              {cfg.filterOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </div>
        </div>
        <div className="selection-bar" aria-live="polite">
          <span>{t('directory.selected', { count: selected.size })}</span>
          {selected.size > 0 && (
            <>
              <Button size="small" onClick={() => replaceQuery({ sel: undefined })}>{t('directory.clearSelection')}</Button>
              {firstSelected && <Button size="small" as="a" href={hrefFor('/relations', { view: 'graph', focus: firstSelected })}>{t('directory.showInGraph')}</Button>}
            </>
          )}
          <span className="muted">{t('directory.count', { shown: rows.length, total: visible.length })}</span>
          {hiddenCount > 0 && <span className="muted"><LockClosed16Regular aria-hidden /> {t('directory.hiddenInternal', { count: hiddenCount })}</span>}
        </div>
        <div className="table-scroll">
          <table className="data-table" data-testid="directory-table">
            <thead>
              <tr>
                <th scope="col" className="select-col"><span className="visually-hidden">{t('directory.selectColumn')}</span></th>
                {cfg.columns.map((c) => <th key={c.header} scope="col" className={c.numeric ? 'num' : ''}>{t(c.header)}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className={selected.has(e.id) ? 'selected' : ''}>
                  <td className="select-col">
                    <Checkbox checked={selected.has(e.id)} onChange={(_, d) => toggle(e.id, d.checked === true)} aria-label={t('directory.selectRow', { name: tx(e.name) })} />
                  </td>
                  {cfg.columns.map((c) => (
                    <td key={c.header} className={c.numeric ? 'num' : ''}>
                      {c.internal && audience === 'external' ? <span className="masked"><LockClosed16Regular aria-hidden /> {t('card.maskedValue')}</span> : c.cell(e)}
                    </td>
                  ))}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={cfg.columns.length + 1} className="empty">{t('directory.empty')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
