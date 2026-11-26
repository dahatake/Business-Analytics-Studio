import { useCallback, useMemo } from 'react';
import { MessageBar, MessageBarBody } from '@fluentui/react-components';
import { getEntity } from '../data/pack.ts';
import { allowedEdges, newsExclusion } from '../data/relationAnalysis.ts';
import type { Entity } from '../data/schema.ts';
import { useI18n } from '../i18n/index.ts';
import { useSettings } from '../state/settings.ts';
import { hrefFor, replaceQuery, useRoute } from '../state/router.ts';
import { PageHeader, Panel } from '../ui/Panel.tsx';
import { EntityRef } from '../ui/EntityRef.tsx';
import { isHidden } from '../ui/cardSpecs.ts';
import { EntityEditorDialog } from '../ui/entry/EntityEditorDialog.tsx';
import { isEditableKind } from '../ui/entry/entitySpecs.ts';
import { usePackVersion } from '../state/packEdits.ts';

type Allow = (e: Entity) => boolean;

/**
 * The relation table: every link between pack items, and the editor that step tasks open (`edit=` / `create=`) to
 * fix a missing source, cause or KPI. The business process itself is drawn on the business process screen (FR-380).
 */
export function Relations() {
  const { t } = useI18n();
  const route = useRoute();
  const audience = useSettings((s) => s.audience);
  const packVersion = usePackVersion((s) => s.version);
  const edit = getEntity(route.query.get('edit') ?? '');
  const editingEntity = edit && isEditableKind(edit.kind) && !isHidden(edit, audience) ? edit : null;
  const editingKind = editingEntity && isEditableKind(editingEntity.kind) ? editingEntity.kind : null;
  const create = route.query.get('create');
  const creatingKind = create && isEditableKind(create) ? create : null;
  // News-feed headlines, and items that rest on them alone, are left out of the table.
  const allow = useCallback<Allow>((e) => !isHidden(e, audience), [audience]);
  const excluded = useMemo(() => newsExclusion((e) => audience === 'internal' || e.classification !== 'internal'), [audience]);
  const tableEdges = useMemo(() => allowedEdges(allow), [allow, packVersion]);

  return (
    <div className="screen screen-relations">
      {(editingKind || creatingKind) && <EntityEditorDialog kind={editingKind ?? creatingKind} id={editingEntity?.id} focusField={route.query.get('field')} onClose={() => replaceQuery({ edit: undefined, field: undefined, create: undefined })} />}
      <PageHeader title={t('relations.title')} subtitle={t('relations.subtitle')} />
      <MessageBar intent="info" data-testid="relations-process-link">
        <MessageBarBody>{t('relations.processLink')} <a href={hrefFor('/process')}>{t('nav.process')}</a></MessageBarBody>
      </MessageBar>
      {excluded.headlines + excluded.derived > 0 && (
        <MessageBar intent="info" data-testid="news-excluded">
          <MessageBarBody>{t('relations.newsExcluded', { headlines: excluded.headlines, derived: excluded.derived })}</MessageBarBody>
        </MessageBar>
      )}
      <Panel title={t('relations.tableTitle')} rationale="visual.relationTable" testId="relation-table" id="relation-table">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr><th scope="col">{t('relations.col.from')}</th><th scope="col">{t('relations.col.relation')}</th><th scope="col">{t('relations.col.to')}</th></tr>
            </thead>
            <tbody>
              {tableEdges.map((e) => (
                <tr key={`${e.source}-${e.type}-${e.target}`}>
                  <td><EntityRef id={e.source} /></td>
                  <td>{t(`relation.${e.type}`)}</td>
                  <td><EntityRef id={e.target} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}