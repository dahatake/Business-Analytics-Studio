import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Field, Input, Link, MessageBar, MessageBarBody, Select, Spinner } from '@fluentui/react-components';
import { ArrowSync20Regular, PersonKey20Regular, ShieldKeyhole20Regular, SignOut20Regular } from '@fluentui/react-icons';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import {
  RelayError, assignEntraRole, inspectEntraInstance, listEntraInstances, listEntraTenants, signOutEntra, startEntraSignIn,
  type EntraService, type FoundryInstanceDetail, type FoundryInstanceInfo, type FoundryTenantInfo,
} from './relayClient.ts';
import type { MediaService } from '../../ai/mediaConnection.ts';
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
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Deployments the app prefers when a resource has several (the router first, then the latest chat model). */
const PREFERRED = [/^model-router/i, /gpt-chat-latest/i, /chat-latest/i];
const preferredDeployment = (d: FoundryInstanceDetail['deployments']) =>
  PREFERRED.map((re) => d.find((x) => re.test(x.model) || re.test(x.name))).find(Boolean) ?? d[0];

type Copy = Record<'note' | 'loading' | 'instance' | 'instanceHint' | 'pick' | 'none' | 'ok' | 'missing' | 'assignHint' | 'askAdmin', MessageKey>;
const COPY: Record<EntraService, Copy> = {
  foundry: {
    note: 'ai.auth.entraIdNote', loading: 'ai.entra.loading', instance: 'ai.entra.instance', instanceHint: 'ai.entra.instanceHint', pick: 'ai.entra.pickInstance',
    none: 'ai.entra.noInstances', ok: 'ai.entra.access.ok', missing: 'ai.entra.access.missing', assignHint: 'ai.entra.access.assignHint', askAdmin: 'ai.entra.access.askAdmin',
  },
  speech: {
    note: 'ai.entra.speech.note', loading: 'ai.entra.speech.loading', instance: 'ai.entra.speech.instance', instanceHint: 'ai.entra.speech.instanceHint',
    pick: 'ai.entra.speech.pickInstance', none: 'ai.entra.speech.noInstances', ok: 'ai.entra.media.access.ok', missing: 'ai.entra.media.access.missing',
    assignHint: 'ai.entra.speech.assignHint', askAdmin: 'ai.entra.speech.askAdmin',
  },
  vision: {
    note: 'ai.entra.vision.note', loading: 'ai.entra.vision.loading', instance: 'ai.entra.vision.instance', instanceHint: 'ai.entra.vision.instanceHint',
    pick: 'ai.entra.vision.pickInstance', none: 'ai.entra.vision.noInstances', ok: 'ai.entra.media.access.ok', missing: 'ai.entra.media.access.missing',
    assignHint: 'ai.entra.vision.assignHint', askAdmin: 'ai.entra.vision.askAdmin',
  },
};

/** A Speech or Vision resource picked with Entra ID (FR-324); the caller keeps it as its draft. */
export interface MediaEntraTarget {
  service: MediaService;
  tenantId: string;
  resourceId: string;
  onSelect: (instance: FoundryInstanceInfo | null) => void;
}

/**
 * Microsoft Entra ID for Microsoft Foundry: sign in once (the relay keeps MSAL's token cache in its encrypted vault), then
 * pick one of the resources the account can read and one of its chat deployments. This screen never sees a token.
 * With `media` the same sign-in picks an Azure AI Speech / Vision resource instead (no deployments; FR-324).
 */
export function EntraConnection({ media }: { media?: MediaEntraTarget } = {}) {
  const { t } = useI18n();
  const service: EntraService = media?.service ?? 'foundry';
  const copy = COPY[service];
  const id = (suffix: string) => (media ? `ai-${media.service}-entra-${suffix}` : `ai-entra-${suffix}`);
  const entra = useAiSettings((s) => s.entra);
  const reachable = useAiSettings((s) => s.relayReachable);
  const foundryEndpoint = useAiSettings((s) => s.endpoint);
  const deployment = useAiSettings((s) => s.deployment);
  const foundryTenant = useAiSettings((s) => s.entraTenantId);
  const tenantId = media ? media.tenantId : foundryTenant;
  const { update, refreshRelay } = useAiSettings.getState();
  const select = (instance: FoundryInstanceInfo | null) => {
    if (media) media.onSelect(instance);
    else update(instance?.endpoint ? { endpoint: instance.endpoint, entraTenantId: instance.tenantId, deployment: '' } : { endpoint: '', entraTenantId: '', deployment: '' });
  };
  const [instances, setInstances] = useState<FoundryInstanceInfo[] | null>(null);
  const [tenants, setTenants] = useState<FoundryTenantInfo[]>([]);
  const [directory, setDirectory] = useState(() => tenantId || entra?.tenantId || '');
  const [directoryInput, setDirectoryInput] = useState('');
  const [reload, setReload] = useState(0);
  const [detail, setDetail] = useState<FoundryInstanceDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<{ intent: 'error' | 'success'; text: string } | null>(null);
  const polling = useRef(0);
  const instanceRequest = useRef(0);
  const inspectRequest = useRef(0);
  const signedIn = entra?.signedIn === true;
  const pending = entra?.signIn === 'pending';
  const selected = instances?.find((i) => i.endpoint !== null && i.tenantId === tenantId && (media ? i.id === media.resourceId : i.endpoint === foundryEndpoint)) ?? null;

  useEffect(() => {
    if (signedIn && !directory && entra?.tenantId) setDirectory(entra.tenantId.toLowerCase());
  }, [signedIn, directory, entra?.tenantId]);

  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    void listEntraTenants(AbortSignal.timeout(90_000)).then((result) => {
      if (active) setTenants(result);
    }, (error: unknown) => {
      if (active) setMessage({ intent: 'error', text: t(`ai.entra.err.${entraMessage(error)}`) });
    });
    return () => { active = false; };
  }, [signedIn, entra?.account, reload, t]);

  useEffect(() => {
    if (!signedIn || !directory) return;
    const request = ++instanceRequest.current;
    setLoading(true);
    setInstances(null);
    setNeedsSignIn(false);
    void listEntraInstances(directory, AbortSignal.timeout(90_000), service).then((result) => {
      if (request === instanceRequest.current) setInstances(result);
    }, (error: unknown) => {
      if (request !== instanceRequest.current) return;
      const code = entraMessage(error);
      setNeedsSignIn(code === 'interactionRequired' || code === 'authFailed');
      setMessage({ intent: 'error', text: t(`ai.entra.err.${code}`) });
    }).finally(() => {
      if (request === instanceRequest.current) setLoading(false);
    });
    return () => { instanceRequest.current += 1; };
  }, [signedIn, directory, entra?.account, reload, t, service]);

  useEffect(() => () => { polling.current += 1; inspectRequest.current += 1; }, []);

  const inspect = useCallback(async (instance: FoundryInstanceInfo, pickDeployment: boolean) => {
    const request = ++inspectRequest.current;
    setInspecting(true);
    setDetail(null);
    try {
      const d = await inspectEntraInstance(instance.id, instance.tenantId, AbortSignal.timeout(60_000), service);
      if (request !== inspectRequest.current) return;
      setDetail(d);
      if (service !== 'foundry') return;
      const current = useAiSettings.getState().deployment;
      if (pickDeployment || !d.deployments.some((x) => x.name === current)) {
        const best = preferredDeployment(d.deployments);
        if (best) update({ deployment: best.name });
      }
    } catch (error) {
      if (request === inspectRequest.current) setMessage({ intent: 'error', text: t(`ai.entra.err.${entraMessage(error)}`) });
    } finally {
      if (request === inspectRequest.current) setInspecting(false);
    }
  }, [t, update, service]);

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
      if (polling.current !== run) return;
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
          setMessage(null);
          setReload((n) => n + 1);
          return;
        }
        if (state !== 'pending') {
          setSignInUrl(null);
          setMessage({ intent: 'error', text: t('ai.entra.signInFailed') });
          return;
        }
      }
      if (polling.current === run) {
        setSignInUrl(null);
        setMessage({ intent: 'error', text: t('ai.entra.signInFailed') });
      }
    } catch (error) {
      if (polling.current === run) setMessage({ intent: 'error', text: t(`ai.entra.err.${entraMessage(error)}`) });
    }
  };

  const signOut = async () => {
    polling.current += 1;
    setSignInUrl(null);
    if (!await signOutEntra()) {
      setMessage({ intent: 'error', text: t('ai.entra.err.failed') });
      return;
    }
    instanceRequest.current += 1;
    inspectRequest.current += 1;
    setInstances(null);
    setTenants([]);
    setDetail(null);
    setDirectory('');
    setLoading(false);
    setInspecting(false);
    await refreshRelay();
    setMessage({ intent: 'success', text: t('ai.entra.signedOut') });
  };

  const chooseDirectory = (value: string) => {
    const next = value.toLowerCase();
    if (next === directory) return;
    instanceRequest.current += 1;
    inspectRequest.current += 1;
    setDirectory(next);
    setInstances(null);
    setDetail(null);
    setInspecting(false);
    setNeedsSignIn(false);
    setMessage(null);
    select(null);
  };

  const choose = (id: string) => {
    const instance = instances?.find((i) => i.id === id);
    inspectRequest.current += 1;
    setInspecting(false);
    setMessage(null);
    setDetail(null);
    if (!instance?.endpoint) {
      select(null);
      return;
    }
    select(instance);
    void inspect(instance, true);
  };

  const assign = async () => {
    if (!selected) return;
    const request = ++inspectRequest.current;
    setInspecting(true);
    setMessage(null);
    try {
      const result = await assignEntraRole(selected.id, selected.tenantId, service);
      if (request === inspectRequest.current) {
        setDetail(result);
        setMessage({ intent: 'success', text: t('ai.entra.assigned') });
      }
    } catch (error) {
      if (request === inspectRequest.current) setMessage({ intent: 'error', text: t(`ai.entra.err.${entraMessage(error)}`) });
    } finally {
      if (request === inspectRequest.current) setInspecting(false);
    }
  };

  const directories = directory && !tenants.some((x) => x.tenantId === directory)
    ? [...tenants, { tenantId: directory, name: directory, signedIn: false }] : tenants;

  return (
    <div className="ai-stack" data-testid={media ? `ai-${media.service}-entra` : 'ai-entra'}>
      <p className="muted">{t(copy.note)}</p>
      <p className="ai-status" data-testid={id('account')}>
        <span>{t('ai.entra.account')}</span>
        <Badge appearance="tint" color={signedIn ? 'success' : 'informative'}>{signedIn ? entra?.account ?? '' : t('ai.entra.notSignedIn')}</Badge>
      </p>
      <div className="ai-row">
        {!signedIn && (
          <Button appearance="primary" icon={pending ? <Spinner size="tiny" /> : <PersonKey20Regular />} onClick={() => void signIn()} disabled={!reachable} data-testid={id('signin')}>
            {t(pending ? 'ai.entra.signInPending' : 'ai.entra.signIn')}
          </Button>
        )}
        {signedIn && (
          <>
            <Button icon={loading ? <Spinner size="tiny" /> : <ArrowSync20Regular />} onClick={() => { setMessage(null); setReload((n) => n + 1); }} disabled={loading} data-testid={id('reload')}>{t('ai.entra.reload')}</Button>
            <Button icon={<SignOut20Regular />} onClick={() => void signOut()} data-testid={id('signout')}>{t('ai.entra.signOut')}</Button>
          </>
        )}
      </div>
      {signInUrl && <p className="muted" data-testid={id('signin-link')}>{t('ai.entra.signInPending')} <Link href={signInUrl} target="_blank" rel="noopener noreferrer">{t('ai.entra.openSignIn')}</Link></p>}
      {signedIn && (
        <>
          <Field label={t('ai.entra.directory')} hint={t('ai.entra.directoryHint')}>
            <Select value={directory} onChange={(_, d) => chooseDirectory(d.value)} data-testid={id('directory')}>
              <option value="" disabled>{t('ai.entra.pickDirectory')}</option>
              {directories.map((x) => <option key={x.tenantId} value={x.tenantId}>{x.name === x.tenantId ? x.tenantId : `${x.name} (${x.tenantId})`}</option>)}
            </Select>
          </Field>
          <Field label={t('ai.entra.directoryId')} hint={t('ai.entra.directoryIdHint')}>
            <Input value={directoryInput} onChange={(_, d) => setDirectoryInput(d.value)} data-testid={id('directory-id')} />
          </Field>
          <div className="ai-row">
            <Button onClick={() => {
              const id = directoryInput.trim();
              if (!TENANT_ID.test(id)) {
                setMessage({ intent: 'error', text: t('ai.entra.err.invalidTenant') });
                return;
              }
              chooseDirectory(id);
            }} data-testid={id('directory-use')}>{t('ai.entra.useDirectory')}</Button>
          </div>
          {directory && (
            <Button onClick={() => void signIn(directory)} disabled={pending} data-testid={id('directory-signin')}>
              {t(needsSignIn ? 'ai.entra.signInRequired' : 'ai.entra.signInDirectory')}
            </Button>
          )}
        </>
      )}
      {signedIn && loading && instances === null && <p className="muted" role="status"><Spinner size="tiny" /> {t(copy.loading)}</p>}
      {signedIn && instances !== null && instances.length === 0 && <p className="muted" data-testid={id('empty')}>{t(copy.none)}</p>}
      {signedIn && instances !== null && instances.length > 0 && (
        <Field label={t(copy.instance)} hint={t(copy.instanceHint)}>
          <Select value={selected?.id ?? ''} onChange={(_, d) => choose(d.value)} data-testid={id('instance')}>
            <option value="" disabled>{t(copy.pick)}</option>
            {instances.map((i) => (
              <option key={i.id} value={i.id} disabled={i.endpoint === null}>
                {i.endpoint === null ? t('ai.entra.noSubdomain', { name: i.name }) : `${i.name} — ${i.subscriptionName || i.subscriptionId} / ${i.resourceGroup} (${i.location})`}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {selected && (
        <p className="ai-status" data-testid={id('selected')}>
          <span>{selected.kind}</span>
          {selected.keyAuthDisabled && <Badge appearance="tint" color="informative">{t('ai.entra.keyDisabled')}</Badge>}
          {detail && (
            <Badge appearance="tint" color={detail.access.canCall ? 'success' : 'warning'} data-testid={id('access')}>
              {t(detail.access.canCall ? copy.ok : copy.missing)}
            </Badge>
          )}
        </p>
      )}
      {selected && inspecting && <Spinner size="tiny" />}
      {!media && selected && detail && detail.deployments.length === 0 && <p role="alert" data-testid={id('no-deployments')}>{t('ai.entra.noDeployments')}</p>}
      {!media && selected && detail && detail.deployments.length > 0 && (
        <Field label={t('ai.entra.deployment')}>
          <Select value={deployment} onChange={(_, d) => update({ deployment: d.value })} data-testid={id('deployment')}>
            {!detail.deployments.some((x) => x.name === deployment) && <option value="" disabled>{t('ai.entra.deployment')}</option>}
            {detail.deployments.map((x) => <option key={x.name} value={x.name}>{`${x.name} (${x.model}${x.version ? ` ${x.version}` : ''}, ${x.sku})`}</option>)}
          </Select>
        </Field>
      )}
      {selected && detail && !detail.access.canCall && (
        <div className="ai-stack">
          <p className="muted">{t(detail.access.canAssign ? copy.assignHint : copy.askAdmin)}</p>
          {detail.access.canAssign && (
            <div className="ai-row">
              <Button icon={<ShieldKeyhole20Regular />} onClick={() => void assign()} disabled={inspecting} data-testid={id('assign')}>{t('ai.entra.assign')}</Button>
            </div>
          )}
        </div>
      )}
      {message && <MessageBar intent={message.intent} data-testid={id('msg')}><MessageBarBody>{message.text}</MessageBarBody></MessageBar>}
    </div>
  );
}
