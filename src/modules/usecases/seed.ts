import type { LText } from '../../data/schema.ts';
import type { UseCase, UseCaseStep } from './store.ts';

const l = (ja: string, en: string): LText => ({ ja, en });
const step = (title: LText, description: LText): UseCaseStep => ({ title, description });
const SEEDED_AT = '2026-10-01T00:00:00.000Z';

/**
 * FR-180: demo use cases for the demo work target, bilingual, at least PARAM-060 (= 2) per persona view so a
 * persona can compare solutions. Ids reference the sample pack (solutions, issues, KPIs).
 */
export function demoUseCases(): UseCase[] {
  const seeds: Omit<UseCase, 'origin' | 'updatedAt'>[] = [
    {
      id: 'uc-demo-exec-portfolio',
      name: l('DX 投資の優先順位を決める', 'Prioritize digital investments'),
      summary: l('課題の影響と実現性から、投資する解決策を経営会議で選ぶ。', 'Choose which solutions to fund in the board meeting from impact and feasibility.'),
      persona: 'executive',
      steps: [
        step(l('課題を一覧する', 'List the issues'), l('5 つの課題を影響と実現性で並べる。', 'Rank the five issues by impact and feasibility.')),
        step(l('効果を比べる', 'Compare benefits'), l('解決策ごとの年間効果と費用を比べる。', 'Compare annual benefit and cost per solution.')),
        step(l('投資を決める', 'Decide the investment'), l('上位 2 件に予算を付ける。', 'Fund the top two solutions.')),
      ],
      effect: l('投資判断が 1 回の会議で終わる', 'Investment decided in one meeting'),
      relatedIds: ['issue-lead-time', 'issue-quality', 'sol-demand-planning', 'sol-vision-inspection'],
    },
    {
      id: 'uc-demo-exec-cash',
      name: l('キャッシュフローを毎週確認する', 'Review cash flow every week'),
      summary: l('売掛金の回収状況を週次で確認し、遅れている顧客に手を打つ。', 'Check collections weekly and act on late-paying customers.'),
      persona: 'executive',
      steps: [
        step(l('DSO を見る', 'Look at DSO'), l('売掛金回収日数の推移を確認する。', 'Check the trend of days sales outstanding.')),
        step(l('遅れを特定する', 'Find late payers'), l('期日を超えた請求書を顧客別に並べる。', 'List overdue invoices by customer.')),
        step(l('対応を指示する', 'Assign follow-ups'), l('営業と経理に回収の担当を割り当てる。', 'Assign collection owners in sales and finance.')),
      ],
      effect: l('DSO を 45 日へ短縮', 'DSO down to 45 days'),
      relatedIds: ['issue-cash', 'sol-e-invoice', 'kpi-dso'],
    },
    {
      id: 'uc-demo-biz-promise',
      name: l('確実な納期を即答する', 'Promise reliable delivery dates instantly'),
      summary: l('営業が商談中に、在庫と生産計画から確実な納期を回答する。', 'Sales answers a reliable delivery date during the meeting from stock and the production plan.'),
      persona: 'business',
      steps: [
        step(l('受注を入力する', 'Enter the order'), l('製品と数量、希望納期を入れる。', 'Enter product, quantity and requested date.')),
        step(l('在庫を引き当てる', 'Allocate stock'), l('全拠点の在庫から引き当てる。', 'Allocate stock across all sites.')),
        step(l('生産枠を確保する', 'Reserve production'), l('不足分の生産枠を計画に入れる。', 'Add the shortfall to the production plan.')),
        step(l('納期を回答する', 'Confirm the date'), l('確定した納期を顧客に伝える。', 'Tell the customer the confirmed date.')),
      ],
      effect: l('リードタイム 16 日→10 日', 'Lead time 16 → 10 days'),
      relatedIds: ['issue-lead-time', 'sol-demand-planning', 'kpi-lead-time', 'kpi-otd'],
    },
    {
      id: 'uc-demo-biz-invoice',
      name: l('請求から入金までを自動化する', 'Automate invoice to cash'),
      summary: l('納品と同時に電子請求を送り、入金を自動で消し込む。', 'Send e-invoices on delivery and match payments automatically.'),
      persona: 'business',
      steps: [
        step(l('納品を記録する', 'Record the delivery'), l('納品物の完了を登録する。', 'Mark the deliverable as done.')),
        step(l('電子請求を送る', 'Send the e-invoice'), l('請求書を自動で作成して送る。', 'Create and send the invoice automatically.')),
        step(l('入金を消し込む', 'Match the payment'), l('入金データと請求書を自動で照合する。', 'Match incoming payments to invoices.')),
      ],
      effect: l('消込の手作業をゼロに', 'Zero manual matching'),
      relatedIds: ['issue-cash', 'sol-e-invoice', 'kpi-dso'],
    },
    {
      id: 'uc-demo-it-data',
      name: l('受注と在庫のデータを統合する', 'Unify order and inventory data'),
      summary: l('拠点ごとの在庫と受注データを 1 つのデータ基盤にまとめる。', 'Bring site inventory and order data into one data platform.'),
      persona: 'it',
      steps: [
        step(l('データ源を洗い出す', 'Inventory the sources'), l('拠点ごとの在庫システムと受注システムを一覧する。', 'List the inventory and order systems at each site.')),
        step(l('項目を対応づける', 'Map the columns'), l('品目コードと拠点コードを共通化する。', 'Align item codes and site codes.')),
        step(l('連携を自動化する', 'Automate the feeds'), l('1 時間ごとに差分を取り込む。', 'Load changes every hour.')),
        step(l('品質を監視する', 'Monitor quality'), l('欠損と重複を毎日確認する。', 'Check gaps and duplicates daily.')),
      ],
      effect: l('全拠点の在庫が 1 時間以内に見える', 'All-site stock visible within one hour'),
      relatedIds: ['issue-lead-time', 'sol-demand-planning'],
    },
    {
      id: 'uc-demo-it-twin',
      name: l('設備の電力データを集める', 'Collect machine power data'),
      summary: l('設備ごとの電力を計測し、エネルギーのデジタルツインに送る。', 'Meter each machine and feed the energy digital twin.'),
      persona: 'it',
      steps: [
        step(l('計測点を決める', 'Choose meter points'), l('電力の大きい設備から計測する。', 'Start with the most power-hungry machines.')),
        step(l('データを送る', 'Stream the data'), l('1 分ごとの電力をクラウドへ送る。', 'Send per-minute power to the cloud.')),
        step(l('ツインに反映する', 'Update the twin'), l('設備別の電力をデジタルツインに表示する。', 'Show per-machine power in the digital twin.')),
      ],
      effect: l('CO2 を月 300 t 削減', 'CO2 down 300 t per month'),
      relatedIds: ['issue-energy', 'sol-energy-twin', 'kpi-co2'],
    },
    {
      id: 'uc-demo-field-inspect',
      name: l('AI で外観検査を標準化する', 'Standardize visual inspection with AI'),
      summary: l('検査員の判定を画像 AI が支援し、ばらつきをなくす。', 'Image AI supports inspectors so judgments are consistent.'),
      persona: 'field',
      steps: [
        step(l('製品を撮影する', 'Capture the product'), l('ラインのカメラで全数を撮影する。', 'Line cameras capture every unit.')),
        step(l('AI が判定する', 'AI judges'), l('不良の疑いがある箇所を示す。', 'AI highlights suspected defects.')),
        step(l('検査員が確認する', 'Inspector confirms'), l('検査員が最終判定を入力する。', 'The inspector enters the final judgment.')),
      ],
      effect: l('初期不良率 610→300 ppm', 'Early failures 610 → 300 ppm'),
      relatedIds: ['issue-quality', 'sol-vision-inspection', 'kpi-defect'],
    },
    {
      id: 'uc-demo-field-energy',
      name: l('待機電力を毎朝止める', 'Cut idle power every morning'),
      summary: l('始業前に待機電力の大きい設備を確認し、止める。', 'Before the shift, find machines wasting idle power and switch them off.'),
      persona: 'field',
      steps: [
        step(l('一覧を開く', 'Open the list'), l('待機電力の大きい設備の一覧を見る。', 'Open the list of machines with high idle power.')),
        step(l('設備を止める', 'Switch off'), l('不要な設備を停止する。', 'Switch off machines that are not needed.')),
        step(l('結果を記録する', 'Record the result'), l('削減した電力を記録する。', 'Record the power saved.')),
      ],
      effect: l('電力コストを 8% 削減', 'Power cost down 8%'),
      relatedIds: ['issue-energy', 'sol-energy-twin', 'kpi-co2'],
    },
  ];
  return seeds.map((s) => ({ ...s, origin: 'registered', updatedAt: SEEDED_AT }));
}
