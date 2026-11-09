import { useId, type ReactNode } from 'react';
import { Button, Popover, PopoverSurface, PopoverTrigger, Text } from '@fluentui/react-components';
import { Info16Regular } from '@fluentui/react-icons';
import { useI18n, type MessageKey } from '../i18n/index.ts';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

/** F-3.3.2: every visual states why it was chosen for this data. */
export function Rationale({ text }: { text: MessageKey }) {
  const { t } = useI18n();
  return (
    <Popover withArrow positioning="below-end">
      <PopoverTrigger disableButtonEnhancement>
        <Button size="small" appearance="subtle" icon={<Info16Regular />}>
          <span className="rationale-label">{t('visual.why')}</span>
        </Button>
      </PopoverTrigger>
      <PopoverSurface className="rationale-surface" aria-label={t('visual.why')}>
        <Text>{t(text)}</Text>
      </PopoverSurface>
    </Popover>
  );
}

export function Panel({ title, rationale, actions, children, className, testId, id: targetId }: {
  title: string;
  rationale?: MessageKey;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
  id?: string;
}) {
  const id = useId();
  return (
    <section id={targetId} tabIndex={targetId ? -1 : undefined} className={`panel ${className ?? ''}`} aria-labelledby={id} data-testid={testId}>
      <div className="panel-header">
        <h2 id={id} className="panel-title">{title}</h2>
        <div className="panel-actions">
          {actions}
          {rationale && <Rationale text={rationale} />}
        </div>
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}
