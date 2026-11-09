import { Badge, Button, Text } from '@fluentui/react-components';
import { ArrowLeft24Regular, ArrowRight16Regular, ArrowLeft16Regular, Diagram24Regular, LockClosed16Regular } from '@fluentui/react-icons';
import { businessChain, getEntity, neighbors } from '../data/pack.ts';
import type { RelationType } from '../data/pack.ts';
import { useI18n } from '../i18n/index.ts';
import { useSettings } from '../state/settings.ts';
import { hrefFor } from '../state/router.ts';
import { EntityImage } from '../ui/EntityImage.tsx';
import { EntityRef } from '../ui/EntityRef.tsx';
import { isHidden, specFor, type CardField } from '../ui/cardSpecs.ts';
import { kindIcon } from '../ui/icons.ts';
import { Panel } from '../ui/Panel.tsx';
import { NotFound } from './NotFound.tsx';

function BackButton() {
  const { t } = useI18n();
  return (
    <Button
      appearance="subtle"
      icon={<ArrowLeft24Regular />}
      onClick={() => {
        if (window.history.length > 1) window.history.back();
        else window.location.hash = '/directory';
      }}
      data-testid="back"
    >
      {t('entity.back')}
    </Button>
  );
}

export function EntityPage({ id }: { id: string }) {
  const { t, tx, fmt } = useI18n();
  const audience = useSettings((s) => s.audience);
  const e = getEntity(id);
  if (!e) return <NotFound />;

  if (isHidden(e, audience)) {
    return (
      <div className="screen">
        <BackButton />
        <div className="restricted-page" role="status">
          <LockClosed16Regular aria-hidden />
          <h1 className="page-title">{t('card.restrictedName')}</h1>
          <p>{t('card.restrictedBody')}</p>
        </div>
      </div>
    );
  }

  const KindIcon = kindIcon[e.kind];
  const spec = specFor(e.kind);
  const fields = (spec.fields as CardField[]).filter((f) => !(f.internal && audience === 'external'));
  const related = neighbors(e.id).filter((n) => n.edge.type !== 'citedFrom' && !isHidden(n.entity, audience));
  const groups = new Map<string, { type: RelationType; direction: 'in' | 'out'; ids: string[] }>();
  for (const n of related) {
    const key = `${n.direction}:${n.edge.type}`;
    const g = groups.get(key) ?? { type: n.edge.type, direction: n.direction, ids: [] };
    g.ids.push(n.entity.id);
    groups.set(key, g);
  }
  const hiddenRelated = neighbors(e.id).filter((n) => isHidden(n.entity, audience)).length;
  const chain = e.kind === 'customer' ? businessChain(e.id).filter((c) => !isHidden(c.deal, audience)) : [];

  return (
    <div className="screen screen-entity" data-entity-id={e.id}>
      <BackButton />
      <header className="entity-hero">
        <EntityImage entity={e} size={120} label={t('entity.imageAlt', { name: tx(e.name) })} />
        <div>
          <span className="detail-card-kind"><KindIcon aria-hidden /> {t(`kind.${e.kind}`)}</span>
          <h1 className="page-title">{tx(e.name)}</h1>
          <p className="page-subtitle">{tx(e.description)}</p>
          <div className="detail-card-badges">
            {e.author === 'sample' && <Badge appearance="tint" color="informative">{t('badge.sample')}</Badge>}
            {e.classification === 'internal' && <Badge appearance="tint" color="warning" icon={<LockClosed16Regular />}>{t('badge.internal')}</Badge>}
            <Badge appearance="outline">{t(`world.${e.world}`)}</Badge>
          </div>
          <Button as="a" appearance="secondary" icon={<Diagram24Regular />} href={hrefFor('/relations', { view: 'graph', focus: e.id })}>{t('entity.showInGraph')}</Button>
        </div>
      </header>

      <div className="grid-2">
        <Panel title={t('entity.facts')}>
          <dl className="facts">
            {fields.map((f) => (
              <div key={f.label}><dt>{t(f.label)}</dt><dd>{f.value(e as never, { t, tx, fmt })}</dd></div>
            ))}
          </dl>
        </Panel>
        <Panel title={t('entity.related')} testId="related-panel">
          {groups.size === 0 && <p className="muted">{t('entity.noRelated')}</p>}
          {[...groups.values()].map((g) => (
            <section key={`${g.direction}:${g.type}`} className="related-group">
              <h3 className="subhead">
                {g.direction === 'out' ? <ArrowRight16Regular aria-hidden /> : <ArrowLeft16Regular aria-hidden />}
                {t(g.direction === 'out' ? 'entity.outgoing' : 'entity.incoming', { relation: t(`relation.${g.type}`) })}
              </h3>
              <ul className="ref-list">
                {g.ids.map((rid) => <li key={rid}><EntityRef id={rid} image={['person', 'customer', 'product'].includes(getEntity(rid)!.kind)} /></li>)}
              </ul>
            </section>
          ))}
          {hiddenRelated > 0 && <p className="muted"><LockClosed16Regular aria-hidden /> {t('directory.hiddenInternal', { count: hiddenRelated })}</p>}
        </Panel>
      </div>

      {chain.length > 0 && (
        <Panel title={t('entity.chain')} rationale="visual.chainTree" testId="business-chain">
          <ul className="chain-tree">
            {chain.map(({ deal, deliverables }) => (
              <li key={deal.id}>
                <EntityRef id={deal.id} />
                {deliverables.length > 0 ? (
                  <ul>
                    {deliverables.map(({ deliverable, invoices }) => (
                      <li key={deliverable.id}>
                        <EntityRef id={deliverable.id} />
                        {invoices.length > 0 ? (
                          <ul>{invoices.map((inv) => <li key={inv.id}><EntityRef id={inv.id} /> <Text size={200}>{t(`invoiceStatus.${inv.status}`)}</Text></li>)}</ul>
                        ) : <p className="muted">{t('entity.noInvoice')}</p>}
                      </li>
                    ))}
                  </ul>
                ) : <p className="muted">{t('entity.noDeliverable')}</p>}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {e.sourceIds.length > 0 && (
        <Panel title={t('entity.sources')}>
          <ul className="ref-list">
            {e.sourceIds.map((s) => <li key={s}><EntityRef id={s} /></li>)}
          </ul>
        </Panel>
      )}
    </div>
  );
}
