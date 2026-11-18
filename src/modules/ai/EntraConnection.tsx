import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Field, Link, MessageBar, MessageBarBody, Select, Spinner } from '@fluentui/react-components';
import { ArrowSync20Regular, PersonKey20Regular, ShieldKeyhole20Regular, SignOut20Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import {
  RelayError, assignEntraRole, inspectEntraInstance, listEntraInstances, signOutEntra, startEntraSignIn,
  type FoundryInstanceDetail, type FoundryInstanceInfo, type FoundryTenantInfo,
} from './relayClient.ts';
import { useAiSettings } from './settingsStore.ts';

const ENTRA_ERRORS = [
  'notSignedIn', 'interactionRequired', 'signInPending', 'signInFailed', 'authFailed', 'invalidResource', 'invalidTenant', 'armForbidden', 'armError',
  'armTimeout', 'roleAssignFailed', 'outboundNotAllowed',
] as const;
type EntraMessage = (typeof ENTRA_ERRORS)[number] | 'failed';
const entraMessage = (error: unknown): EntraMessage => {
  const code = error instanceof RelayError ? error.code : '';
  return (ENTRA_ERRORS as readonly string[]).includes(code) ? (code as EntraMessage) : 'failed';
};
const POLL_MS = 2_000;
const POLL_LIMIT_MS = 10 * 60_000;
/** Deployments the app prefers when a resource has several (the router first, then the latest chat model). */
const PREFERRED = [/^model-router/i, /gpt-chat-latest/i, /chat-latest/i];
const preferredDeployment = (d: FoundryInstanceDetail['deployments']) =>
  PREFERRED.map((re) => d.find((x) => re.test(x.model) || re.test(x.name))).find(Boolean) ?? d[0];

/**
 * Microsoft Entra ID for Microsoft Foundry: sign in once (the relay keeps MSAL's token cache in its encrypted vault), then
 * pick one of the resources the account can read and one of its chat deployments. This screen never sees a token.
 */
export function EntraConnection() {
  const { t } = useI18n();
  const entra = useAiSettings((s) => s.entra);
  const reachable = useAiSettings((s) => s.relayReachable);
  const endpoint = useAiSettings((s) => s.endpoint);
  const deployment = useAiSettings((s) => s.deployment);
  const tenantId = useAiSettings((s) => s.entraTenantId);
  const { update, refreshRelay } = useAiSettings.getState();
  const [instances, setInstances] = useState<FoundryInstanceInfo[] | null>(null);
  const [tenants, setTenants] = useState<FoundryTenantInfo[]>([]);
  const [detail, setDetail] = useState<FoundryInstanceDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<{ intent: 'error' | 'success'; text: string } | null>(null);
  const polling = useRef(0);
  const signedIn = entra?.signedIn === true;
  const pending = entra?.signIn === 'pending';
  const selected = instances?.find((i) => i.endpoint !== null && i.endpoint === endpoint && i.tenantId === tenantId) ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await listEntraInstances(AbortSignal.timeout(90_000));
      setInstances(r.instances);
      setTenants(r.tenants);
    } catch (error) {
      setMessage({ intent: 'error', text: t(`ai.entra.err.${entraMessage(error)}`) });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (signedIn && instances === null && !loading) void load();
  }, [signedIn, instances, loading, load]);

  useEffect(() => () => { polling.current += 1; }, []);

  const inspect = useCallback(async (instance: FoundryInstanceInfo, pickDeployment: boolean) => {
    setInspecting(true);
    setDetail(null);
    try {
      const d = await inspectEntraInstance(instance.id, instance.tenantId, AbortSignal.timeout(60_000));
      setDetail(d);
      const current = useAiSettings.getState().deployment;
      if (pickDeployment || !d.deployments.some((x) => x.name === current)) {
        const best = preferredDeployment(d.deployments);
        if (best) update({ deployment: best.name });
      }
    } catch (error) {
      setMessage({ intent: 'error', text: t(`ai.entra.err.${entraMessage(error)}`) });
    } finally {
      setInspecting(false);
    }
  }, [t, update]);

  const selectedId = selected?.id;
  useEffect(() => {
    if (selected && detail === null && !inspecting) void inspect(selected, false);
    // Only when the selected resource changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const signIn = async (tenant?: string) => {
    setMessage(null);
    setSignInUrl(null);
    const run = ++polling.current;
    try {
      const { url } = await startEntraSignIn(tenant);
      if (url) {
        setSignInUrl(url);
        window.open(url, '_blank', 'noopener,noreferrer');
      }
      await refreshRelay();
      const started = Date.now();
      while (polling.current === run && Date.now() - started < POLL_LIMIT_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (polling.current !== run) return;
        await refreshRelay();
        const state = useAiSettings.getState().entra?.signIn;
        if (state === 'signedIn') {
          setSignInUrl(null);
          setInstances(null);
          return;
        }
        if (state !== 'pending') {
          setSignInUrl(null);
          setMessage({ intent: 'error', text: t('ai.entra.signInFailed') });
          return;
        }
      }
    } catch (error) {
      setMessage({ intent: 'error', text: t(`ai.entra.err.${entraMessage(error)}`) });
    }
  };

  const signOut = async () => {
    polling.current += 1;
    setSignInUrl(null);
    await signOutEntra();
    setInstances(null);
    setTenants([]);
    setDetail(null);
    await refreshRelay();
    setMessage({ intent: 'success', text: t('ai.entra.signedOut') });
  };

  const choose = (id: string) => {
    const instance = instances?.find((i) => i.id === id);
    setMessage(null);
    setDetail(null);
    if (!instance?.endpoint) {
      update({ endpoint: '', entraTenantId: '', deployment: '' });
      return;
    }
    update({ endpoint: instance.endpoint, entraTenantId: instance.tenantId, deployment: '' });
    void inspect(instance, true);
  };

  const assign = async () => {
    if (!selected) return;
    setInspecting(true);
    setMessage(null);
    try {
      setDetail(await assignEntraRole(selected.id, selected.tenantId));
      setMessage({ intent: 'success', text: t('ai.entra.assigned') });
    } catch (error) {
      setMessage({ intent: 'error', text: t(`ai.entra.err.${entraMessage(error)}`) });
    } finally {
      setInspecting(false);
    }
  };

  const missingTenants = tenants.filter((x) => !x.signedIn);

  return (
    <div className="ai-stack" data-testid="ai-entra">
      <p className="muted">{t('ai.auth.entraIdNote')}</p>
      <p className="ai-status" data-testid="ai-entra-account">
        <span>{t('ai.entra.account')}</span>
        <Badge appearance="tint" color={signedIn ? 'success' : 'informative'}>{signedIn ? entra?.account ?? '' : t('ai.entra.notSignedIn')}</Badge>
      </p>
      <div className="ai-row">
        {!signedIn && (
          <Button appearance="primary" icon={pending ? <Spinner size="tiny" /> : <PersonKey20Regular />} onClick={() => void signIn()} disabled={!reachable} data-testid="ai-entra-signin">
            {t(pending ? 'ai.entra.signInPending' : 'ai.entra.signIn')}
          </Button>
        )}
        {signedIn && (
          <>
            <Button icon={loading ? <Spinner size="tiny" /> : <ArrowSync20Regular />} onClick={() => void load()} disabled={loading} data-testid="ai-entra-reload">{t('ai.entra.reload')}</Button>
            <Button icon={<SignOut20Regular />} onClick={() => void signOut()} data-testid="ai-entra-signout">{t('ai.entra.signOut')}</Button>
          </>
        )}
      </div>
      {signInUrl && <p className="muted" data-testid="ai-entra-signin-link">{t('ai.entra.signInPending')} <Link href={signInUrl} target="_blank" rel="noopener noreferrer">{t('ai.entra.openSignIn')}</Link></p>}
      {signedIn && loading && instances === null && <p className="muted" role="status"><Spinner size="tiny" /> {t('ai.entra.loading')}</p>}
      {signedIn && instances !== null && instances.length === 0 && <p className="muted" data-testid="ai-entra-empty">{t('ai.entra.noInstances')}</p>}
      {signedIn && instances !== null && instances.length > 0 && (
        <Field label={t('ai.entra.instance')} hint={t('ai.entra.instanceHint')}>
          <Select value={selected?.id ?? ''} onChange={(_, d) => choose(d.value)} data-testid="ai-entra-instance">
            <option value="" disabled>{t('ai.entra.pickInstance')}</option>
            {instances.map((i) => (
              <option key={i.id} value={i.id} disabled={i.endpoint === null}>
                {i.endpoint === null ? t('ai.entra.noSubdomain', { name: i.name }) : `${i.name} — ${i.subscriptionName || i.subscriptionId} / ${i.resourceGroup} (${i.location})`}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {selected && (
        <p className="ai-status" data-testid="ai-entra-selected">
          <span>{selected.kind}</span>
          {selected.keyAuthDisabled && <Badge appearance="tint" color="informative">{t('ai.entra.keyDisabled')}</Badge>}
          {detail && (
            <Badge appearance="tint" color={detail.access.canCall ? 'success' : 'warning'} data-testid="ai-entra-access">
              {t(detail.access.canCall ? 'ai.entra.access.ok' : 'ai.entra.access.missing')}
            </Badge>
          )}
        </p>
      )}
      {selected && inspecting && <Spinner size="tiny" />}
      {selected && detail && detail.deployments.length === 0 && <p role="alert" data-testid="ai-entra-no-deployments">{t('ai.entra.noDeployments')}</p>}
      {selected && detail && detail.deployments.length > 0 && (
        <Field label={t('ai.entra.deployment')}>
          <Select value={deployment} onChange={(_, d) => update({ deployment: d.value })} data-testid="ai-entra-deployment">
            {!detail.deployments.some((x) => x.name === deployment) && <option value="" disabled>{t('ai.entra.deployment')}</option>}
            {detail.deployments.map((x) => <option key={x.name} value={x.name}>{`${x.name} (${x.model}${x.version ? ` ${x.version}` : ''}, ${x.sku})`}</option>)}
          </Select>
        </Field>
      )}
      {selected && detail && !detail.access.canCall && (
        <div className="ai-stack">
          <p className="muted">{t(detail.access.canAssign ? 'ai.entra.access.assignHint' : 'ai.entra.access.askAdmin')}</p>
          {detail.access.canAssign && (
            <div className="ai-row">
              <Button icon={<ShieldKeyhole20Regular />} onClick={() => void assign()} disabled={inspecting} data-testid="ai-entra-assign">{t('ai.entra.assign')}</Button>
            </div>
          )}
        </div>
      )}
      {signedIn && missingTenants.length > 0 && (
        <div className="ai-stack" data-testid="ai-entra-tenants">
          <span className="ai-label">{t('ai.entra.otherTenants')}</span>
          <div className="ai-row">
            {missingTenants.map((x) => (
              <Button key={x.tenantId} size="small" onClick={() => void signIn(x.tenantId)} disabled={pending}>{t('ai.entra.signInTenant', { name: x.name || x.tenantId })}</Button>
            ))}
          </div>
        </div>
      )}
      {message && <MessageBar intent={message.intent} data-testid="ai-entra-msg"><MessageBarBody>{message.text}</MessageBarBody></MessageBar>}
    </div>
  );
}
