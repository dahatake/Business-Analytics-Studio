import { Suspense, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
  Badge, Button, FluentProvider, MessageBar, MessageBarBody, Spinner, Text, Tooltip, createDarkTheme, createLightTheme, type Theme,
} from '@fluentui/react-components';
import {
  Speaker224Regular, SpeakerMute24Regular, Accessibility24Regular, LockClosed16Regular, Eye16Regular,
} from '@fluentui/react-icons';
import { MotionBehaviourProvider } from '@fluentui/react-motion';
import { useI18n } from './i18n/index.ts';
import { useSettings } from './state/settings.ts';
import { useEffectiveDark, useReducedMotion } from './state/motion.ts';
import { hrefFor, useRoute, useRouteTarget } from './state/router.ts';
import { sound } from './audio/sound.ts';
import { loaded } from './data/pack.ts';
import { companyAnchorRequiresInternalView } from './data/companyAnchor.ts';
import { LiveFeedBar } from './ui/LiveFeedBar.tsx';
import { DetailCardHost } from './ui/DetailCardHost.tsx';
import { Opening } from './ui/Opening.tsx';
import { LanguageToggle } from './ui/LanguageToggle.tsx';
import { LaunchScreen } from './modules/project/LaunchScreen.tsx';
import { useLaunch } from './state/launch.ts';
import { NotFound } from './screens/NotFound.tsx';
import { EntityPage } from './screens/EntityPage.tsx';
import { NAV_GROUPS, SCREENS, screenFor } from './app/modules.ts';
import { ActionSlots, ContextSlot, Overlays, StepBandSlot } from './app/globals.tsx';
import { useBrandVariants } from './modules/ops/theme.ts';
import { DeviceStorageStatus, useDeviceBlocked } from './ui/DeviceStorageStatus.tsx';

/** Fluent themes from the 16-step brand ramp (PARAM-017). Dark mode lifts brand foregrounds for contrast. */
function useThemes(): { dark: Theme; light: Theme } {
  const brand = useBrandVariants();
  return useMemo(() => ({
    dark: { ...createDarkTheme(brand), colorBrandForeground1: brand[120], colorBrandForeground2: brand[130], colorBrandForegroundLink: brand[130], colorBrandForegroundLinkHover: brand[140] },
    light: createLightTheme(brand),
  }), [brand]);
}

function TopBar({ restricted }: { restricted: boolean }) {
  const { t } = useI18n();
  const { muted, setMuted, setMotion, audience, setAudience } = useSettings();
  const reopenLaunch = useLaunch((s) => s.reopen);
  const reduced = useReducedMotion();
  return (
    <header className="topbar">
      <div className="topbar-row">
        <Tooltip content={t('proj.target.launch')} relationship="description">
          <button type="button" className="brand brand-button" onClick={() => {
            reopenLaunch();
            requestAnimationFrame(() => document.getElementById('main')?.focus());
          }}>
            <span className="brand-mark" aria-hidden />
            <Text weight="semibold" size={400} className="brand-name">{t('app.title')}</Text>
          </button>
        </Tooltip>
        {loaded.pack.isSample && (
          <div className="topbar-context">
            <Badge appearance="tint" color="informative" data-testid="sample-pack-badge">{t('badge.samplePack')}</Badge>
          </div>
        )}
        <div className="topbar-work">
          <ContextSlot restricted={restricted} />
        </div>
        <LanguageToggle />
      </div>
      <div className="topbar-row commandbar" role="toolbar" aria-label={t('topbar.commands')}>
        <div className="commandbar-actions">
          {!restricted && <ActionSlots />}
        </div>
        <div className="commandbar-view">
          <Tooltip content={t('audience.help')} relationship="description">
            <Button
              size="small"
              appearance={audience === 'external' ? 'primary' : 'subtle'}
              icon={audience === 'external' ? <LockClosed16Regular /> : <Eye16Regular />}
              onClick={() => setAudience(audience === 'external' ? 'internal' : 'external')}
              data-testid="audience-toggle"
            >
              {t(`audience.${audience}`)}
            </Button>
          </Tooltip>
          <Button size="small" appearance="subtle" icon={<Accessibility24Regular />} aria-pressed={reduced} onClick={() => setMotion(reduced ? 'full' : 'reduce')} data-testid="motion-toggle">
            {t('motion.reduceShort')}
          </Button>
          <Button size="small" appearance="subtle" icon={muted ? <SpeakerMute24Regular /> : <Speaker224Regular />} aria-pressed={!muted} onClick={() => setMuted(!muted)} data-testid="sound-toggle">
            {t('sound.short')}
          </Button>
        </div>
      </div>
    </header>
  );
}

/** Keeps --chrome-h equal to the sticky header + live feed height, so the nav rail sits right below it at any wrap. */
function useChromeHeight(ref: React.RefObject<HTMLDivElement | null>, mounted: boolean) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      const h = `${Math.round(el.getBoundingClientRect().height)}px`;
      el.parentElement?.style.setProperty('--chrome-h', h);
      // WCAG 2.4.11: focus and scroll targets stop below the sticky header instead of under it (CSS turns it off when static).
      document.documentElement.style.setProperty('--chrome-h', h);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, mounted]);
}

function isActive(path: string, current: string) {
  if (path === '/') return current === '/';
  return current === path || current.startsWith(`${path}/`) || (path === '/directory' && current.startsWith('/entity'));
}

function NavRail({ current }: { current: string }) {
  const { t } = useI18n();
  return (
    <nav className="rail" aria-label={t('nav.label')}>
      {NAV_GROUPS.map(({ group, label }) => (
        <div key={group} className="rail-group">
          <h2 className="rail-group-title" id={`nav-${group}`}>{t(label)}</h2>
          <ul aria-labelledby={`nav-${group}`}>
            {SCREENS.filter((s) => s.group === group).map(({ path, label: itemLabel, Icon }) => (
              <li key={path}>
                <a href={hrefFor(path)} className="rail-link" aria-current={isActive(path, current) ? 'page' : undefined} onClick={() => sound.play('tap')}>
                  <Icon aria-hidden />
                  <span>{t(itemLabel)}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function RouteTarget() {
  useRouteTarget();
  return null;
}

function Screen() {
  const { t } = useI18n();
  const route = useRoute();
  const [first, second] = route.segments;
  if (first === 'entity') return second ? <EntityPage id={second} /> : <NotFound />;
  const def = screenFor(route.path);
  if (!def) return <NotFound />;
  const Component = def.component;
  return (
    <Suspense fallback={<Spinner className="screen-loading" label={t('app.loading')} />}>
      <Component />
      <RouteTarget />
    </Suspense>
  );
}

export function App() {
  const storageBlocked = useDeviceBlocked();
  const { t, lang } = useI18n();
  const dark = useEffectiveDark();
  const reduced = useReducedMotion();
  const route = useRoute();
  const { muted, bgm, sfx, volume, audience } = useSettings();
  const restricted = audience === 'external' && companyAnchorRequiresInternalView(loaded.pack.extensions);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dataset.motion = reduced ? 'reduced' : 'full';
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }, [lang, reduced, dark]);

  useEffect(() => {
    sound.configure({ muted, bgm, sfx, volume });
  }, [muted, bgm, sfx, volume]);

  // F-3.2.3: going back restores the scroll position of that exact URL (query state is in the URL itself).
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => sessionStorage.setItem(`scroll:${window.location.hash}`, String(window.scrollY)));
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  useLayoutEffect(() => {
    const saved = sessionStorage.getItem(`scroll:${window.location.hash}`);
    window.scrollTo(0, saved ? Number(saved) : 0);
  }, [route.path]);

  const themes = useThemes();
  const chromeRef = useRef<HTMLDivElement>(null);
  const stage = useLaunch((s) => s.stage);
  useChromeHeight(chromeRef, stage === 'app');
  const navItem = useMemo(() => (route.segments[0] === 'entity' ? undefined : screenFor(route.path)), [route.path, route.segments]);
  useEffect(() => {
    document.title = stage !== 'app'
      ? `${t('proj.launch.title')} · ${t('app.title')}`
      : `${navItem ? t(navItem.label) : t('app.title')} · ${t('app.title')}`;
  }, [navItem, t, stage]);

  return (
    <FluentProvider theme={dark ? themes.dark : themes.light}>
      {/* Fluent's motion components use the Web Animations API, which the CSS rule for reduced motion cannot stop. */}
      <MotionBehaviourProvider value={reduced ? 'skip' : 'default'}>
      {/* Layout styles live on an inner wrapper: Fluent copies the provider className onto portal mount nodes. */}
      <DeviceStorageStatus />
      <div className={`app ${dark ? 'theme-dark' : 'theme-light'}`} data-motion={reduced ? 'reduced' : 'full'} inert={storageBlocked}>
      <div className="aurora" aria-hidden />
      {stage !== 'app' ? (
        // Start-up step 2: choose a company and project before any project screen (step 3) is shown.
        <LaunchScreen />
      ) : (
        <>
          <button type="button" className="skip-link" onClick={() => document.getElementById('main')?.focus()}>{t('a11y.skip')}</button>
          <div className="chrome" ref={chromeRef}>
            <TopBar restricted={restricted} />
            {!restricted && <LiveFeedBar />}
            {!restricted && <StepBandSlot />}
          </div>
          <div className="layout">
            <NavRail current={route.path} />
            <main id="main" tabIndex={-1} className="main" key={route.path}>
              {restricted
                ? <MessageBar intent="warning" data-testid="company-anchor-external-restricted"><MessageBarBody>{t('proj.anchor.externalRestricted')}</MessageBarBody></MessageBar>
                : <Screen />}
            </main>
          </div>
          {!restricted && <DetailCardHost />}
          {!restricted && <Overlays />}
        </>
      )}
      <Opening />
      </div>
      </MotionBehaviourProvider>
    </FluentProvider>
  );
}

