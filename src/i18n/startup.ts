/**
 * Strings the entry shows before the app and its full dictionaries load (start-up and device storage). The full
 * dictionaries include these, so a key is defined once and translate() finds it as usual.
 */
export const startupJa = {
  'startup.loading': 'アプリを準備しています…',
  'device.loading': 'このPCの保存データを読み込んでいます…',
  'device.title': 'データ保護のため操作を停止しました',
  'device.saved': 'このPCに保存済み',
  'device.saving': 'このPCに保存中…',
  'device.error': '端末への読み込み・保存に失敗しました。空のデータで作業を続けたり、保存成功として扱ったりはしません。サーバーと保存先の空き容量・権限を確認してください。未保存の内容は復旧用コピーに含まれます。',
  'device.conflict': '別のウィンドウの保存データと競合しました。新しいデータを上書きしていません。復旧用コピーをダウンロードし、再読み込みして内容を確認してください。旧ブラウザーデータも削除していません。',
  'device.retry': '再読み込み・再試行',
  'device.recovery': '復旧用コピーをダウンロード',
  'device.recoveryError': '復旧用コピーの作成にも失敗しました。この画面を閉じず、ブラウザーの保存領域を確認してください。',
  'device.useDevice': '旧データを残して、このPCの保存データを使う',
  'device.moved': 'データの保存先フォルダーが別のウィンドウで変更されました。古いフォルダーへは保存していません。再読み込みして、新しい保存先のデータで続けてください。',
  'device.locationUnavailable': '設定したデータの保存先フォルダーが見つからないか、BAS のデータがありません（外付けドライブが外れた、フォルダーを移動・削除した、など）。空のデータで続けたり、新しく作ったりはしていません。フォルダーを元に戻して再読み込みするか、既定の保存先に戻してください。',
  'device.locationPath': '設定している保存先: {path}',
  'device.useDefaultLocation': '既定の保存先に戻す（設定中のフォルダーは削除しません）',
} as const;

export const startupEn: Record<keyof typeof startupJa, string> = {
  'startup.loading': 'Preparing the app…',
  'device.loading': 'Loading data saved on this PC…',
  'device.title': 'Editing stopped to protect your data',
  'device.saved': 'Saved on this PC',
  'device.saving': 'Saving on this PC…',
  'device.error': 'Device data could not be loaded or saved. The app will not continue with empty data or claim a successful save. Check the server, disk space and permissions. Unsaved changes are included in the recovery copy.',
  'device.conflict': 'Data conflicts with another window. Newer device data has not been overwritten. Download a recovery copy, then reload to review the saved data. Legacy browser data has not been deleted.',
  'device.retry': 'Reload / retry',
  'device.recovery': 'Download recovery copy',
  'device.recoveryError': 'The recovery copy could not be created either. Keep this page open and check browser storage.',
  'device.useDevice': 'Use device data and keep legacy data',
  'device.moved': 'The data folder was changed in another window. Nothing was saved to the old folder. Reload to continue with the data in the new folder.',
  'device.locationUnavailable': 'The chosen data folder cannot be found or holds no BAS data (for example, an external drive was removed or the folder was moved or deleted). The app has not continued with empty data or created new data. Restore the folder and reload, or go back to the default folder.',
  'device.locationPath': 'Chosen data folder: {path}',
  'device.useDefaultLocation': 'Go back to the default folder (the chosen folder is not deleted)',
};

export type StartupKey = keyof typeof startupJa;
type Lang = 'ja' | 'en';
const dictionaries: Record<Lang, Record<StartupKey, string>> = { ja: startupJa, en: startupEn };

export function translateStartup(lang: Lang, key: StartupKey, vars?: Record<string, string>): string {
  const template = dictionaries[lang][key];
  return vars ? template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? vars[name]! : m)) : template;
}
