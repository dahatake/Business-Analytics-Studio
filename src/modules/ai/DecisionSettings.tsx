import { useEffect, useRef, useState } from 'react';
import { Field, MessageBar, MessageBarBody, Select } from '@fluentui/react-components';
import { useI18n } from '../../i18n/index.ts';
import { decisionUsesFoundry } from '../../ai/decision.ts';
import type { FoundryServicesInfo } from '../../ai/mediaConnection.ts';
import { inspectFoundryServices } from './relayClient.ts';
import { useAiSettings } from './settingsStore.ts';

export function DecisionSettings() {
  const { t } = useI18n();
  const s = useAiSettings();
  const [services, setServices] = useState<FoundryServicesInfo | null>(null);
  const [checking, setChecking] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<'admin' | 'check' | 'save' | null>(null);
  const request = useRef(0);
  const connection = s.relayConnection;
  const endpoint = connection?.endpoint;
  const auth = connection?.auth;
  const tenantId = connection?.tenantId;
  const selected = s.decision?.verifiedAt && decisionUsesFoundry(s.decision, connection) ? s.decision.deployment : '';

  useEffect(() => {
    const controller = new AbortController();
    const current = ++request.current;
    setChecking(true);
    setServices(null);
    setError(null);
    setSaving(false);
    void inspectFoundryServices(AbortSignal.any([controller.signal, AbortSignal.timeout(95_000)])).then((result) => {
      if (current === request.current) setServices(result);
    }, () => {
      if (current === request.current) setError('check');
    }).finally(() => {
      if (current === request.current) setChecking(false);
    });
    return () => { controller.abort(); request.current += 1; };
  }, [endpoint, auth, tenantId, s.connectionVerifiedAt, s.entra?.account]);

  const choose = async (value: string) => {
    if (saving) return;
    const current = request.current;
    setSaving(true);
    setError(null);
    try {
      const result = await s.selectDecisionModel(value || null);
      if (current !== request.current) return;
      if (!result.ok) setError(result.error === 'resourceUnavailable' ? 'admin' : result.error === 'inspectionFailed' ? 'check' : 'save');
    } catch {
      if (current === request.current) setError('save');
    } finally {
      if (current === request.current) setSaving(false);
    }
  };
  const unavailable = (['speech', 'vision', 'decision'] as const).filter((service) => services?.[service] === 'unavailable'
    || service === 'decision' && s.decision?.accessError === 'resourceUnavailable' && decisionUsesFoundry(s.decision, connection));
  const unknown = services ? (['speech', 'vision', 'decision'] as const).filter((service) => services[service] === 'unknown') : [];
  const names = (items: readonly ('speech' | 'vision' | 'decision')[]) => items.map((item) => t(`ai.foundry.service.${item}`)).join(t('ai.listSep'));

  return (
    <div className="ai-stack" data-testid="ai-foundry-models">
      <Field
        label={t('ai.decision.model')}
        validationState={error ? 'error' : 'none'}
        validationMessage={error ? t(`ai.foundry.modelError.${error}`) : checking ? t('ai.foundry.checking') : saving ? t('ai.foundry.saving') : undefined}
      >
        <Select value={selected} onChange={(_, d) => void choose(d.value)} disabled={checking || saving || services?.decision !== 'available' && !selected} data-testid="ai-decision-deployment">
          <option value="">{t('ai.decision.none')}</option>
          {selected && !services?.deployments.some((d) => d.name === selected) && <option value={selected} disabled>{selected}</option>}
          {services?.deployments.map((d) => <option key={d.name} value={d.name}>{`${d.name} (${d.model})`}</option>)}
        </Select>
      </Field>
      {unavailable.length > 0 && <MessageBar intent="warning" data-testid="ai-foundry-admin"><MessageBarBody>{t('ai.foundry.adminSetup', { services: names(unavailable) })}</MessageBarBody></MessageBar>}
      {unknown.length > 0 && <MessageBar intent="warning" data-testid="ai-foundry-check-failed"><MessageBarBody>{t('ai.foundry.checkFailed', { services: names(unknown) })}</MessageBarBody></MessageBar>}
    </div>
  );
}
