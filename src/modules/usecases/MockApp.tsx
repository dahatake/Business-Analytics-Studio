import { useState } from 'react';
import { Badge, Button, Field, Input } from '@fluentui/react-components';
import { useI18n } from '../../i18n/index.ts';
import { loc, type Localizable } from '../../state/text.ts';
import type { MockScreen } from './mockapp.ts';

/** FR-043: an interactive mini mock app (1–3 screens), always labelled as a mock. */
export function MockApp({ screens }: { screens: MockScreen[] }) {
  const { t, lang, fmt } = useI18n();
  const [current, setCurrent] = useState(screens[0]?.id ?? '');
  const [rows, setRows] = useState<{ name: Localizable; amount: number }[]>(() => screens.find((s) => s.rows.length > 0)?.rows ?? []);
  const [values, setValues] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const screen = screens.find((s) => s.id === current) ?? screens[0];
  if (!screen) return null;
  const hasList = screens.some((s) => s.kind === 'list');

  return (
    <div className="uc-mock" data-testid="uc-mock" data-screens={screens.length}>
      <div className="uc-mock-bar">
        <Badge appearance="filled" color="warning">{t('uc.mock.badge')}</Badge>
        <span className="muted">{t('uc.mock.note')}</span>
      </div>
      <nav className="uc-mock-nav" aria-label={t('uc.mock.nav')}>
        {screens.map((s, i) => (
          <Button key={s.id} size="small" appearance={s.id === screen.id ? 'primary' : 'secondary'} aria-current={s.id === screen.id ? 'page' : undefined} onClick={() => setCurrent(s.id)}>
            {t('uc.mock.screenN', { n: i + 1, name: t(`uc.mock.kind.${s.kind}`) })}
          </Button>
        ))}
      </nav>
      <section className="uc-mock-screen" aria-label={loc(screen.title, lang)}>
        <h3 className="subhead">{loc(screen.title, lang)}</h3>
        {screen.kind === 'list' && (
          <div className="table-scroll">
            <table className="data-table compact">
              <caption className="visually-hidden">{loc(screen.title, lang)}</caption>
              <thead><tr><th scope="col">{t('uc.mock.colName')}</th><th scope="col">{t('uc.mock.colAmount')}</th><th scope="col">{t('uc.mock.colSelect')}</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={selected === i ? 'uc-row-selected' : undefined}>
                    <td>{loc(r.name, lang)}</td>
                    <td>{fmt.integer(r.amount)}</td>
                    <td>
                      <Button size="small" aria-pressed={selected === i} onClick={() => setSelected(selected === i ? null : i)}>
                        {selected === i ? t('uc.mock.selected') : t('uc.mock.select')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {screen.kind === 'form' && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              const name = (values[0] ?? '').trim() || t('uc.mock.newItem', { n: rows.length + 1 });
              setRows((r) => [...r, { name, amount: Number(values[1]) || 0 }]);
              setValues({});
              setMessage(hasList ? t('uc.mock.savedToList') : t('uc.mock.saved'));
            }}
          >
            {screen.fields.map((f, i) => (
              <Field key={i} label={loc(f.label, lang)}>
                <Input type={f.input} value={values[i] ?? ''} onChange={(_, d) => setValues((v) => ({ ...v, [i]: d.value }))} />
              </Field>
            ))}
            <div className="toolbar"><Button appearance="primary" type="submit">{t('uc.mock.submit')}</Button></div>
            <p role="status" className="muted">{message}</p>
          </form>
        )}
        {screen.kind === 'summary' && (
          <div className="uc-mock-summary">
            <p className="uc-mock-headline">{screen.headline ? loc(screen.headline, lang) : ''}</p>
            <p>{t('uc.mock.count', { n: rows.length })}</p>
            <ul className="uc-mock-bars">
              {rows.map((r, i) => (
                <li key={i}>
                  <span>{loc(r.name, lang)}</span>
                  <span className="uc-mock-bar-track" aria-hidden="true"><span style={{ width: `${Math.min(100, r.amount * 2)}%` }} /></span>
                  <span>{fmt.integer(r.amount)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
