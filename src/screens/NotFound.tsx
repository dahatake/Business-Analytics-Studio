import { useI18n } from '../i18n/index.ts';
import { hrefFor } from '../state/router.ts';
import { PageHeader } from '../ui/Panel.tsx';

export function NotFound() {
  const { t } = useI18n();
  return (
    <div className="screen">
      <PageHeader title={t('notFound.title')} subtitle={t('notFound.body')} />
      <a href={hrefFor('/')}>{t('notFound.home')}</a>
    </div>
  );
}
