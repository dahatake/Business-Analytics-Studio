import type { CustomerPack, Entity, LText, OptimizationInput } from './schema.ts';

const l = (ja: string, en: string): LText => ({ ja, en });
const sample = { world: 'real' as const, classification: 'shareable' as const, author: 'sample' as const, sourceIds: [] as string[] };

const sites: Entity[] = [
  { ...sample, kind: 'site', type: 'site', id: 'site-tokyo-hq', name: l('東京本社', 'Tokyo HQ'), description: l('経営・営業・設計の拠点。', 'Head office for management, sales and design.'), role: 'hq', lat: 35.681, lon: 139.767, capacityTPerMonth: 0 },
  { ...sample, kind: 'site', type: 'site', id: 'site-nagoya', name: l('名古屋工場', 'Nagoya Plant'), description: l('主力工場。サーボモーターと減速機を生産。', 'Main plant producing servo motors and gearboxes.'), role: 'plant', lat: 35.181, lon: 136.906, capacityTPerMonth: 520 },
  { ...sample, kind: 'site', type: 'site', id: 'site-kitakyushu', name: l('北九州工場', 'Kitakyushu Plant'), description: l('ベアリングと電磁弁の工場。', 'Plant for bearings and solenoid valves.'), role: 'plant', lat: 33.883, lon: 130.875, capacityTPerMonth: 380 },
  { ...sample, kind: 'site', type: 'site', id: 'site-sendai', name: l('仙台工場', 'Sendai Plant'), description: l('センサーと協働ロボットアームの工場。', 'Plant for sensors and collaborative robot arms.'), role: 'plant', lat: 38.268, lon: 140.869, capacityTPerMonth: 300 },
  { ...sample, kind: 'site', type: 'site', id: 'site-osaka-dc', name: l('大阪物流センター', 'Osaka Distribution Center'), description: l('西日本向けの出荷拠点。', 'Shipping hub for western Japan.'), role: 'dc', lat: 34.694, lon: 135.502, capacityTPerMonth: 650 },
  { ...sample, kind: 'site', type: 'site', id: 'site-yokohama-dc', name: l('横浜物流センター', 'Yokohama Distribution Center'), description: l('東日本向けの出荷拠点。', 'Shipping hub for eastern Japan.'), role: 'dc', lat: 35.444, lon: 139.638, capacityTPerMonth: 600 },
];

const people: Entity[] = [
  { ...sample, kind: 'person', type: 'person', id: 'person-sato-yui', name: l('佐藤 結衣', 'Yui Sato'), description: l('需要予測モデルを担当。', 'Owns the demand forecasting model.'), role: l('データアナリスト', 'Data Analyst'), ageBand: '20s', gender: 'female', siteId: 'site-tokyo-hq', portrait: { skin: 'light', hair: 'long', hairColor: 'black', glasses: false, beard: false, outfitHue: 210 } },
  { ...sample, kind: 'person', type: 'person', id: 'person-tanaka-ren', name: l('田中 蓮', 'Ren Tanaka'), description: l('外観検査ラインの立ち上げ担当。', 'Leads the visual inspection line start-up.'), role: l('生産技術エンジニア', 'Production Engineer'), ageBand: '20s', gender: 'male', siteId: 'site-nagoya', portrait: { skin: 'medium', hair: 'crop', hairColor: 'black', glasses: false, beard: false, outfitHue: 160 } },
  { ...sample, kind: 'person', type: 'person', id: 'person-nakamura-aoi', name: l('中村 葵', 'Aoi Nakamura'), description: l('自動車・医療業界の主担当営業。', 'Account lead for automotive and medical customers.'), role: l('営業マネージャー', 'Sales Manager'), ageBand: '30s', gender: 'female', siteId: 'site-tokyo-hq', portrait: { skin: 'light', hair: 'bob', hairColor: 'brown', glasses: true, beard: false, outfitHue: 330 } },
  { ...sample, kind: 'person', type: 'person', id: 'person-kobayashi-kenta', name: l('小林 健太', 'Kenta Kobayashi'), description: l('エネルギー・電子業界の技術営業。', 'Solutions engineer for energy and electronics.'), role: l('セールスエンジニア', 'Sales Engineer'), ageBand: '30s', gender: 'male', siteId: 'site-tokyo-hq', portrait: { skin: 'medium', hair: 'short', hairColor: 'black', glasses: false, beard: false, outfitHue: 25 } },
  { ...sample, kind: 'person', type: 'person', id: 'person-ito-mariko', name: l('伊藤 真理子', 'Mariko Ito'), description: l('全社の品質指標の責任者。', 'Accountable for company-wide quality metrics.'), role: l('品質保証部長', 'Head of Quality Assurance'), ageBand: '40s', gender: 'female', siteId: 'site-nagoya', portrait: { skin: 'light', hair: 'bun', hairColor: 'black', glasses: true, beard: false, outfitHue: 280 } },
  { ...sample, kind: 'person', type: 'person', id: 'person-okafor-daniel', name: l('ダニエル・オカフォー', 'Daniel Okafor'), description: l('調達と物流の計画を統括。', 'Runs procurement and logistics planning.'), role: l('サプライチェーン部長', 'Head of Supply Chain'), ageBand: '40s', gender: 'male', siteId: 'site-yokohama-dc', portrait: { skin: 'deep', hair: 'crop', hairColor: 'black', glasses: false, beard: true, outfitHue: 200 } },
  { ...sample, kind: 'person', type: 'person', id: 'person-watanabe-keiko', name: l('渡辺 恵子', 'Keiko Watanabe'), description: l('請求・入金の業務改革を推進。', 'Drives the invoicing and collections reform.'), role: l('経理部長', 'Head of Finance'), ageBand: '50s', gender: 'female', siteId: 'site-tokyo-hq', portrait: { skin: 'tan', hair: 'bob', hairColor: 'auburn', glasses: false, beard: false, outfitHue: 120 } },
  { ...sample, kind: 'person', type: 'person', id: 'person-yamamoto-hiroshi', name: l('山本 浩', 'Hiroshi Yamamoto'), description: l('北九州工場の操業とエネルギー管理を統括。', 'Runs operations and energy at Kitakyushu.'), role: l('工場長', 'Plant Manager'), ageBand: '50s', gender: 'male', siteId: 'site-kitakyushu', portrait: { skin: 'medium', hair: 'receding', hairColor: 'gray', glasses: true, beard: false, outfitHue: 45 } },
  { ...sample, kind: 'person', type: 'person', id: 'person-suzuki-fumiko', name: l('鈴木 文子', 'Fumiko Suzuki'), description: l('熟練技能の継承プログラムを監修。', 'Advises the skills-transfer program.'), role: l('技術顧問', 'Technical Advisor'), ageBand: '60s', gender: 'female', siteId: 'site-sendai', portrait: { skin: 'light', hair: 'bun', hairColor: 'white', glasses: true, beard: false, outfitHue: 260 } },
  { ...sample, kind: 'person', type: 'person', id: 'person-kato-takeshi', name: l('加藤 武', 'Takeshi Kato'), description: l('DX 投資の最終判断者。', 'Final decision maker for digital investments.'), role: l('取締役 COO', 'Director & COO'), ageBand: '60s', gender: 'male', siteId: 'site-tokyo-hq', portrait: { skin: 'tan', hair: 'receding', hairColor: 'white', glasses: false, beard: true, outfitHue: 220 } },
];

const customers: Entity[] = [
  { ...sample, kind: 'customer', type: 'organization', id: 'cust-sakura-motors', name: l('桜モーターズ', 'Sakura Motors'), description: l('EV 駆動ユニットを量産する自動車メーカー。', 'Automaker mass-producing EV drive units.'), industry: l('自動車', 'Automotive'), regionId: 'region-chubu', illustration: { motif: 'car', hue: 350 } },
  { ...sample, kind: 'customer', type: 'organization', id: 'cust-minato-medical', name: l('みなと医療機器', 'Minato Medical Devices'), description: l('画像診断装置のメーカー。', 'Maker of diagnostic imaging systems.'), industry: l('医療機器', 'Medical devices'), regionId: 'region-kanto', illustration: { motif: 'cross', hue: 200 } },
  { ...sample, kind: 'customer', type: 'organization', id: 'cust-kaze-energy', name: l('風力エナジー', 'Kaze Wind Energy'), description: l('洋上風力発電の事業者。', 'Offshore wind power operator.'), industry: l('エネルギー', 'Energy'), regionId: 'region-tohoku', illustration: { motif: 'bolt', hue: 45 } },
  { ...sample, kind: 'customer', type: 'organization', id: 'cust-hikari-electronics', name: l('ひかり電子', 'Hikari Electronics'), description: l('電子部品の実装受託企業。', 'Electronics manufacturing services provider.'), industry: l('電子部品', 'Electronics'), regionId: 'region-kansai', illustration: { motif: 'chip', hue: 270 } },
  { ...sample, kind: 'customer', type: 'organization', id: 'cust-umi-foods', name: l('うみ食品機械', 'Umi Food Machinery'), description: l('食品加工機械のメーカー。', 'Maker of food processing machinery.'), industry: l('食品機械', 'Food machinery'), regionId: 'region-kyushu', illustration: { motif: 'leaf', hue: 140 } },
  { ...sample, kind: 'customer', type: 'organization', id: 'cust-tsubasa-robotics', name: l('つばさロボティクス', 'Tsubasa Robotics'), description: l('物流ロボットのスタートアップ。', 'Logistics robotics start-up.'), industry: l('ロボティクス', 'Robotics'), regionId: 'region-kanto', illustration: { motif: 'robot', hue: 180 } },
];

const products: Entity[] = [
  { ...sample, kind: 'product', type: 'thing', id: 'prod-servo', name: l('サーボモーター AX', 'AX Servo Motor'), description: l('高トルク・低慣性のサーボモーター。', 'High-torque, low-inertia servo motor.'), category: l('駆動', 'Motion'), siteId: 'site-nagoya', unitPriceJpy: 185_000, illustration: { motif: 'motor', hue: 210 } },
  { ...sample, kind: 'product', type: 'thing', id: 'prod-gearbox', name: l('精密減速機 GX', 'GX Precision Gearbox'), description: l('バックラッシの小さい遊星減速機。', 'Low-backlash planetary gearbox.'), category: l('駆動', 'Motion'), siteId: 'site-nagoya', unitPriceJpy: 142_000, illustration: { motif: 'gear', hue: 30 } },
  { ...sample, kind: 'product', type: 'thing', id: 'prod-bearing', name: l('大型ベアリング BR', 'BR Large Bearing'), description: l('風車のピッチ制御向けベアリング。', 'Bearing for wind-turbine pitch control.'), category: l('機構', 'Mechanical'), siteId: 'site-kitakyushu', unitPriceJpy: 960_000, illustration: { motif: 'bearing', hue: 190 } },
  { ...sample, kind: 'product', type: 'thing', id: 'prod-valve', name: l('衛生対応電磁弁 VL', 'VL Hygienic Solenoid Valve'), description: l('洗浄しやすい構造の電磁弁。', 'Solenoid valve designed for clean-in-place.'), category: l('流体制御', 'Fluid control'), siteId: 'site-kitakyushu', unitPriceJpy: 64_000, illustration: { motif: 'valve', hue: 160 } },
  { ...sample, kind: 'product', type: 'thing', id: 'prod-sensor', name: l('光学センサー OS', 'OS Optical Sensor'), description: l('サブミクロンの位置検出センサー。', 'Sub-micron position sensor.'), category: l('センシング', 'Sensing'), siteId: 'site-sendai', unitPriceJpy: 38_000, illustration: { motif: 'sensor', hue: 260 } },
  { ...sample, kind: 'product', type: 'thing', id: 'prod-arm', name: l('協働ロボットアーム CR', 'CR Collaborative Arm'), description: l('人と並んで働ける 6 軸アーム。', 'Six-axis arm that works next to people.'), category: l('ロボット', 'Robotics'), siteId: 'site-sendai', unitPriceJpy: 3_200_000, illustration: { motif: 'arm', hue: 15 } },
];

const ev = { ...sample, world: 'real' as const };
const deals: Entity[] = [
  { ...ev, kind: 'deal', type: 'event', id: 'deal-sakura-ev', name: l('EV 駆動ユニット量産', 'EV drive unit mass production'), description: l('サーボと減速機の 3 年供給契約。', 'Three-year supply of servos and gearboxes.'), customerId: 'cust-sakura-motors', productIds: ['prod-servo', 'prod-gearbox'], ownerId: 'person-nakamura-aoi', stage: 'won', valueJpy: 186_000_000, closeDate: '2026-08-20' },
  { ...ev, kind: 'deal', type: 'event', id: 'deal-sakura-aftermarket', name: l('保守部品の年間供給', 'Annual spare-parts supply'), description: l('既存ラインの保守部品。', 'Spare parts for existing lines.'), customerId: 'cust-sakura-motors', productIds: ['prod-bearing', 'prod-gearbox'], ownerId: 'person-nakamura-aoi', stage: 'delivered', valueJpy: 28_000_000, closeDate: '2026-04-10' },
  { ...ev, kind: 'deal', type: 'event', id: 'deal-minato-imaging', name: l('画像診断装置向けセンサー', 'Sensors for imaging systems'), description: l('CT 装置の位置検出用センサー。', 'Position sensors for CT scanners.'), customerId: 'cust-minato-medical', productIds: ['prod-sensor'], ownerId: 'person-nakamura-aoi', stage: 'delivered', valueJpy: 64_000_000, closeDate: '2026-05-15' },
  { ...ev, kind: 'deal', type: 'event', id: 'deal-kaze-pitch', name: l('ピッチ制御ベアリング', 'Pitch-control bearings'), description: l('洋上風車 40 基分のベアリング。', 'Bearings for 40 offshore turbines.'), customerId: 'cust-kaze-energy', productIds: ['prod-bearing'], ownerId: 'person-kobayashi-kenta', stage: 'negotiation', valueJpy: 120_000_000, closeDate: '2026-12-18' },
  { ...ev, kind: 'deal', type: 'event', id: 'deal-hikari-line', name: l('実装ライン用電磁弁', 'Valves for assembly lines'), description: l('新設ライン 6 本分の電磁弁。', 'Valves for six new assembly lines.'), customerId: 'cust-hikari-electronics', productIds: ['prod-valve'], ownerId: 'person-kobayashi-kenta', stage: 'proposal', valueJpy: 42_000_000, closeDate: '2027-01-29' },
  { ...ev, kind: 'deal', type: 'event', id: 'deal-umi-hygiene', name: l('衛生対応バルブ更新', 'Hygienic valve upgrade'), description: l('食品ラインの弁とセンサーの更新。', 'Valve and sensor upgrade for food lines.'), customerId: 'cust-umi-foods', productIds: ['prod-valve', 'prod-sensor'], ownerId: 'person-nakamura-aoi', stage: 'won', valueJpy: 38_000_000, closeDate: '2026-09-30' },
  { ...ev, classification: 'internal', kind: 'deal', type: 'event', id: 'deal-tsubasa-cobot', name: l('協働アーム共同開発', 'Co-developed collaborative arm'), description: l('共同開発の条件を交渉中（社外秘）。', 'Co-development terms under negotiation (confidential).'), customerId: 'cust-tsubasa-robotics', productIds: ['prod-arm', 'prod-servo'], ownerId: 'person-kobayashi-kenta', stage: 'lead', valueJpy: 210_000_000, closeDate: '2027-03-31' },
];

const deliverables: Entity[] = [
  { ...ev, kind: 'deliverable', type: 'thing', id: 'dlv-sakura-ev-proto', name: l('試作ユニット 20 台', '20 prototype units'), description: l('量産前の評価用ユニット。', 'Units for pre-production evaluation.'), dealId: 'deal-sakura-ev', dueDate: '2026-10-15', status: 'done' },
  { ...ev, kind: 'deliverable', type: 'thing', id: 'dlv-sakura-ev-mass', name: l('量産初回ロット', 'First mass-production lot'), description: l('初回 2,000 台分。', 'First lot of 2,000 units.'), dealId: 'deal-sakura-ev', dueDate: '2026-12-21', status: 'inProgress' },
  { ...ev, kind: 'deliverable', type: 'thing', id: 'dlv-sakura-am', name: l('保守部品セット', 'Spare-parts kit'), description: l('年間保守部品の一括納入。', 'Annual spare parts in one delivery.'), dealId: 'deal-sakura-aftermarket', dueDate: '2026-05-20', status: 'done' },
  { ...ev, kind: 'deliverable', type: 'thing', id: 'dlv-minato-sensor', name: l('センサー 500 個', '500 sensors'), description: l('校正済みの光学センサー。', 'Calibrated optical sensors.'), dealId: 'deal-minato-imaging', dueDate: '2026-07-31', status: 'done' },
  { ...ev, kind: 'deliverable', type: 'thing', id: 'dlv-umi-valve', name: l('衛生弁 120 台', '120 hygienic valves'), description: l('2 回に分けて納入。', 'Delivered in two batches.'), dealId: 'deal-umi-hygiene', dueDate: '2026-11-30', status: 'inProgress' },
  { ...ev, kind: 'deliverable', type: 'thing', id: 'dlv-kaze-sample', name: l('評価用サンプル', 'Evaluation samples'), description: l('塩害試験用のサンプル 4 個。', 'Four samples for salt-spray testing.'), dealId: 'deal-kaze-pitch', dueDate: '2026-11-20', status: 'planned' },
];

const invoices: Entity[] = [
  { ...ev, world: 'digital', kind: 'invoice', type: 'data', id: 'inv-2026-064', name: l('請求書 2026-064', 'Invoice 2026-064'), description: l('保守部品セットの請求。支払期日を超過。', 'Spare-parts kit. Past due.'), deliverableId: 'dlv-sakura-am', amountJpy: 28_000_000, issuedDate: '2026-05-25', status: 'overdue' },
  { ...ev, world: 'digital', kind: 'invoice', type: 'data', id: 'inv-2026-087', name: l('請求書 2026-087', 'Invoice 2026-087'), description: l('センサー 500 個の請求。', 'Invoice for 500 sensors.'), deliverableId: 'dlv-minato-sensor', amountJpy: 64_000_000, issuedDate: '2026-08-05', status: 'paid' },
  { ...ev, world: 'digital', kind: 'invoice', type: 'data', id: 'inv-2026-101', name: l('請求書 2026-101', 'Invoice 2026-101'), description: l('試作ユニットの請求。', 'Invoice for prototype units.'), deliverableId: 'dlv-sakura-ev-proto', amountJpy: 46_500_000, issuedDate: '2026-10-20', status: 'sent' },
  { ...ev, world: 'digital', kind: 'invoice', type: 'data', id: 'inv-2026-109', name: l('請求書 2026-109', 'Invoice 2026-109'), description: l('衛生弁の前受け請求（第 1 回）。', 'Advance invoice for valves (batch 1).'), deliverableId: 'dlv-umi-valve', amountJpy: 15_200_000, issuedDate: '2026-10-31', status: 'sent' },
  { ...ev, world: 'digital', kind: 'invoice', type: 'data', id: 'inv-2026-115', name: l('請求書 2026-115', 'Invoice 2026-115'), description: l('量産初回ロットの請求（下書き）。', 'Draft invoice for the first mass lot.'), deliverableId: 'dlv-sakura-ev-mass', amountJpy: 62_000_000, issuedDate: '2026-11-06', status: 'draft' },
];

const causes: Entity[] = [
  { ...sample, kind: 'cause', type: 'event', id: 'cause-manual-scheduling', name: l('表計算での手作業の生産計画', 'Manual scheduling in spreadsheets'), description: l('計画の作成に 2 日かかり、変更に追従できない。', 'Plans take two days and cannot follow changes.'), sourceIds: ['src-interview'] },
  { ...sample, kind: 'cause', type: 'event', id: 'cause-siloed-inventory', name: l('拠点ごとに分断された在庫情報', 'Inventory data siloed by site'), description: l('他拠点の在庫を引き当てられない。', 'Stock at other sites cannot be allocated.'), sourceIds: ['src-interview'] },
  { ...sample, kind: 'cause', type: 'event', id: 'cause-manual-inspection', name: l('目視検査のばらつき', 'Inconsistent visual inspection'), description: l('検査員による判定差が大きい。', 'Large variation between inspectors.'), sourceIds: ['src-annual-report'] },
  { ...sample, kind: 'cause', type: 'event', id: 'cause-no-energy-visibility', name: l('設備別の電力が見えない', 'No per-machine energy visibility'), description: l('電力は工場単位でしか計測していない。', 'Power is metered only per plant.'), sourceIds: ['src-dx-survey'] },
  { ...sample, kind: 'cause', type: 'event', id: 'cause-paper-invoicing', name: l('紙と PDF の請求処理', 'Paper and PDF invoicing'), description: l('入金消込を手作業で行っている。', 'Payment matching is manual.'), sourceIds: ['src-interview'] },
  { ...sample, classification: 'internal', kind: 'cause', type: 'event', id: 'cause-tacit-knowledge', name: l('暗黙知に依存した段取り', 'Set-up relies on tacit knowledge'), description: l('熟練者の退職で段取り時間が延びている。', 'Retirements are lengthening set-up time.'), sourceIds: ['src-interview'] },
];

const issues: Entity[] = [
  { ...sample, kind: 'issue', type: 'event', id: 'issue-lead-time', name: l('受注から出荷までが長い', 'Long order-to-ship lead time'), description: l('競合より 1 週間長く、失注の主因になっている。', 'A week longer than competitors; main reason for lost deals.'), impact: 5, feasibility: 3, causeIds: ['cause-manual-scheduling', 'cause-siloed-inventory'], kpiIds: ['kpi-lead-time', 'kpi-otd'], sourceIds: ['src-annual-report'] },
  { ...sample, kind: 'issue', type: 'event', id: 'issue-quality', name: l('初期不良率が高止まり', 'Early-failure rate stays high'), description: l('医療・自動車向けで品質要求が上がっている。', 'Quality demands are rising in medical and automotive.'), impact: 4, feasibility: 4, causeIds: ['cause-manual-inspection'], kpiIds: ['kpi-defect'], sourceIds: ['src-annual-report'] },
  { ...sample, kind: 'issue', type: 'event', id: 'issue-energy', name: l('エネルギーコストの上昇', 'Rising energy costs'), description: l('電力単価の上昇で利益率が 1.2 ポイント低下。', 'Power prices cut margin by 1.2 points.'), impact: 3, feasibility: 4, causeIds: ['cause-no-energy-visibility'], kpiIds: ['kpi-co2'], sourceIds: ['src-dx-survey'] },
  { ...sample, kind: 'issue', type: 'event', id: 'issue-cash', name: l('請求・入金の遅れ', 'Slow invoicing and collection'), description: l('売掛金の回収に平均 61 日かかる（基準時点は 68 日。目標は 45 日）。', 'Receivables take 61 days on average to collect (68 days at baseline; the target is 45).'), impact: 3, feasibility: 5, causeIds: ['cause-paper-invoicing'], kpiIds: ['kpi-dso'], sourceIds: ['src-interview'] },
  { ...sample, classification: 'internal', kind: 'issue', type: 'event', id: 'issue-skills', name: l('熟練技能の継承', 'Transferring expert skills'), description: l('5 年で熟練者の 3 割が退職予定（社外秘）。', '30% of experts retire within five years (confidential).'), impact: 4, feasibility: 2, causeIds: ['cause-tacit-knowledge'], kpiIds: ['kpi-engagement'], sourceIds: ['src-interview'] },
];

const solutions: Entity[] = [
  { ...sample, world: 'digital', kind: 'solution', type: 'system', id: 'sol-demand-planning', name: l('需要予測と生産計画の最適化', 'Demand forecasting and production optimization'), description: l('受注・在庫を統合し、拠点横断で計画を最適化する。', 'Unifies orders and stock to optimize plans across sites.'), issueIds: ['issue-lead-time'], kpiIds: ['kpi-lead-time', 'kpi-otd'], msProducts: ['Microsoft Fabric', 'Azure Machine Learning', 'Power BI'], costJpy: 48_000_000, annualBenefitJpy: 120_000_000 },
  { ...sample, world: 'digital', kind: 'solution', type: 'system', id: 'sol-vision-inspection', name: l('AI 外観検査', 'AI visual inspection'), description: l('画像 AI で判定を標準化する。', 'Standardizes judgments with image AI.'), issueIds: ['issue-quality'], kpiIds: ['kpi-defect'], msProducts: ['Azure AI Vision', 'Azure IoT Operations'], costJpy: 36_000_000, annualBenefitJpy: 85_000_000 },
  { ...sample, world: 'digital', kind: 'solution', type: 'model', id: 'sol-energy-twin', name: l('エネルギーのデジタルツイン', 'Energy digital twin'), description: l('設備別の電力を可視化し、運転を最適化する。', 'Visualizes per-machine power to optimize operation.'), issueIds: ['issue-energy'], kpiIds: ['kpi-co2'], msProducts: ['Azure Digital Twins', 'Microsoft Fabric'], costJpy: 22_000_000, annualBenefitJpy: 40_000_000 },
  { ...sample, world: 'digital', kind: 'solution', type: 'system', id: 'sol-e-invoice', name: l('請求の電子化と自動消込', 'E-invoicing and auto-matching'), description: l('請求から入金消込までを自動化する。', 'Automates invoicing through payment matching.'), issueIds: ['issue-cash'], kpiIds: ['kpi-dso'], msProducts: ['Dynamics 365 Finance', 'Power Automate'], costJpy: 15_000_000, annualBenefitJpy: 30_000_000 },
  { ...sample, world: 'digital', classification: 'internal', kind: 'solution', type: 'system', id: 'sol-knowledge-copilot', name: l('技能伝承 Copilot', 'Skills-transfer Copilot'), description: l('作業記録と動画から手順を引き出せるようにする。', 'Makes procedures searchable from logs and videos.'), issueIds: ['issue-skills'], kpiIds: ['kpi-engagement'], msProducts: ['Microsoft 365 Copilot', 'Azure AI Search'], costJpy: 18_000_000, annualBenefitJpy: 25_000_000 },
];

const metric = { ...sample, world: 'digital' as const, type: 'metric' as const };
const kpis: Entity[] = [
  { ...metric, kind: 'kpi', id: 'kpi-lead-time', name: l('受注〜出荷リードタイム', 'Order-to-ship lead time'), description: l('受注から出荷までの平均日数。', 'Average days from order to shipment.'), unit: l('日', 'days'), baseline: 21, current: 16, target: 10, direction: 'decrease', scale: 'ratio', period: l('2026 年度（月次平均）', 'FY2026 (monthly average)'), ownerId: 'person-okafor-daniel', sourceIds: ['src-annual-report'] },
  { ...metric, kind: 'kpi', id: 'kpi-otd', name: l('納期遵守率', 'On-time delivery'), description: l('約束納期どおりに出荷した割合。', 'Share of orders shipped by the promised date.'), unit: l('%', '%'), baseline: 82, current: 88, target: 95, direction: 'increase', scale: 'ratio', period: l('2026 年度（月次）', 'FY2026 (monthly)'), ownerId: 'person-okafor-daniel', sourceIds: ['src-annual-report'] },
  { ...metric, kind: 'kpi', id: 'kpi-defect', name: l('初期不良率', 'Early-failure rate'), description: l('出荷後 90 日以内の不良の割合。', 'Failures within 90 days of shipment.'), unit: l('ppm', 'ppm'), baseline: 850, current: 610, target: 300, direction: 'decrease', scale: 'ratio', period: l('直近 12 か月', 'Trailing 12 months'), ownerId: 'person-ito-mariko', sourceIds: ['src-annual-report'] },
  { ...metric, kind: 'kpi', id: 'kpi-co2', name: l('CO2 排出量', 'CO2 emissions'), description: l('3 工場の Scope 1・2 の合計。', 'Scope 1 and 2 across three plants.'), unit: l('t-CO2/月', 't-CO2/month'), baseline: 2400, current: 2210, target: 1900, direction: 'decrease', scale: 'ratio', period: l('2026 年度（月次）', 'FY2026 (monthly)'), ownerId: 'person-yamamoto-hiroshi', sourceIds: ['src-dx-survey'] },
  { ...metric, kind: 'kpi', id: 'kpi-dso', name: l('売掛金回収日数（DSO）', 'Days sales outstanding (DSO)'), description: l('売上から入金までの平均日数。', 'Average days from sale to cash.'), unit: l('日', 'days'), baseline: 68, current: 61, target: 45, direction: 'decrease', scale: 'ratio', period: l('四半期', 'Quarterly'), ownerId: 'person-watanabe-keiko', sourceIds: ['src-interview'] },
  { ...metric, kind: 'kpi', id: 'kpi-engagement', name: l('従業員エンゲージメント（eNPS）', 'Employee engagement (eNPS)'), description: l('推奨者の割合から批判者の割合を引いた値（-100〜+100）。', 'Promoters minus detractors (−100 to +100).'), unit: l('ポイント', 'points'), baseline: -12, current: -4, target: 10, direction: 'increase', scale: 'interval', period: l('半期サーベイ', 'Half-year survey'), ownerId: 'person-suzuki-fumiko', sourceIds: ['src-interview'] },
];

const initiatives: Entity[] = [
  { ...sample, world: 'real', kind: 'initiative', type: 'operation', id: 'init-dp-pilot', name: l('需要予測の PoC', 'Demand forecasting PoC'), description: l('名古屋工場の 2 製品で予測精度を検証。', 'Validate forecast accuracy for two products at Nagoya.'), solutionId: 'sol-demand-planning', start: '2026-07-01', end: '2026-09-30', progress: 1, dependsOn: [], ownerId: 'person-sato-yui' },
  { ...sample, world: 'real', kind: 'initiative', type: 'operation', id: 'init-dp-rollout', name: l('生産計画最適化の全工場展開', 'Roll out planning optimization to all plants'), description: l('3 工場の計画を統合して最適化。', 'Integrate and optimize plans of three plants.'), solutionId: 'sol-demand-planning', start: '2026-10-01', end: '2027-03-31', progress: 0.25, dependsOn: ['init-dp-pilot'], ownerId: 'person-okafor-daniel' },
  { ...sample, world: 'real', kind: 'initiative', type: 'operation', id: 'init-vi-pilot', name: l('外観検査のパイロット', 'Visual inspection pilot'), description: l('名古屋工場の 1 ラインで AI 判定を試行。', 'Trial AI judgments on one Nagoya line.'), solutionId: 'sol-vision-inspection', start: '2026-09-01', end: '2026-12-15', progress: 0.6, dependsOn: [], ownerId: 'person-tanaka-ren' },
  { ...sample, world: 'real', kind: 'initiative', type: 'operation', id: 'init-vi-rollout', name: l('外観検査の横展開', 'Scale visual inspection'), description: l('全 9 ラインへ展開。', 'Expand to all nine lines.'), solutionId: 'sol-vision-inspection', start: '2027-01-05', end: '2027-05-31', progress: 0, dependsOn: ['init-vi-pilot'], ownerId: 'person-ito-mariko' },
  { ...sample, world: 'real', kind: 'initiative', type: 'operation', id: 'init-et-model', name: l('エネルギーツインの構築', 'Build the energy twin'), description: l('北九州工場の設備 120 台を接続。', 'Connect 120 machines at Kitakyushu.'), solutionId: 'sol-energy-twin', start: '2026-10-15', end: '2027-02-26', progress: 0.15, dependsOn: [], ownerId: 'person-yamamoto-hiroshi' },
  { ...sample, world: 'real', kind: 'initiative', type: 'operation', id: 'init-ei-launch', name: l('電子請求の稼働', 'Go live with e-invoicing'), description: l('主要 6 社から電子請求へ切り替え。', 'Switch the top six customers to e-invoicing.'), solutionId: 'sol-e-invoice', start: '2026-08-03', end: '2026-11-30', progress: 0.8, dependsOn: [], ownerId: 'person-watanabe-keiko' },
  { ...sample, world: 'real', classification: 'internal', kind: 'initiative', type: 'operation', id: 'init-kc-pilot', name: l('技能伝承 Copilot の試行', 'Skills-transfer Copilot trial'), description: l('仙台工場の段取り作業で試行（社外秘）。', 'Trial on set-up work at Sendai (confidential).'), solutionId: 'sol-knowledge-copilot', start: '2026-11-16', end: '2027-03-15', progress: 0, dependsOn: [], ownerId: 'person-suzuki-fumiko' },
];

const suppliers: Entity[] = [
  { ...sample, kind: 'supplier', type: 'organization', id: 'sup-steel', name: l('西日本鋼材', 'West Japan Steel'), description: l('特殊鋼の主要調達先。', 'Main source of specialty steel.'), regionId: 'region-kyushu' },
  { ...sample, kind: 'supplier', type: 'organization', id: 'sup-electronics', name: l('関東電子部品', 'Kanto Electronic Parts'), description: l('制御基板とセンサー素子の調達先。', 'Supplies control boards and sensor elements.'), regionId: 'region-kanto' },
  { ...sample, kind: 'supplier', type: 'organization', id: 'sup-resin', name: l('近畿樹脂材料', 'Kinki Resin Materials'), description: l('エンジニアリング樹脂の調達先。', 'Supplies engineering plastics.'), regionId: 'region-kansai' },
];

const sources: Entity[] = [
  { ...sample, world: 'digital', kind: 'source', type: 'data', id: 'src-annual-report', name: l('統合報告書 2025（サンプル）', 'Integrated Report 2025 (sample)'), description: l('架空企業のサンプル資料。', 'Sample document of the fictional company.'), publisher: l('青空精機（架空）', 'Aozora Precision (fictional)'), publishedDate: '2026-06-30' },
  { ...sample, world: 'digital', kind: 'source', type: 'data', id: 'src-dx-survey', name: l('製造業 DX 実態調査（サンプル）', 'Manufacturing DX survey (sample)'), description: l('デモ用に作成した架空の調査。', 'Fictional survey made for the demo.'), publisher: l('サンプル調査機関', 'Sample Research Institute'), publishedDate: '2026-03-31' },
  { ...sample, world: 'digital', classification: 'internal', kind: 'source', type: 'data', id: 'src-interview', name: l('現場インタビュー記録', 'Shop-floor interview notes'), description: l('2026 年 9 月の聞き取り（社外秘）。', 'Interviews from September 2026 (confidential).'), publisher: l('青空精機 DX 推進室（架空）', 'Aozora Precision DX Office (fictional)'), publishedDate: '2026-09-26' },
];

const transport = [
  [9_000, 3_000, 6_000, 14_000, 15_000],
  [18_000, 12_000, 8_000, 2_500, 24_000],
  [8_000, 14_000, 17_000, 26_000, 2_500],
];

export const samplePack: CustomerPack & { optimization: OptimizationInput } = {
  packId: 'sample-aozora-precision',
  company: { name: l('青空精機（架空）', 'Aozora Precision (fictional)'), industry: l('精密機械', 'Precision machinery') },
  isSample: true,
  regions: [
    { id: 'region-kanto', name: l('関東', 'Kanto') },
    { id: 'region-chubu', name: l('中部', 'Chubu') },
    { id: 'region-kansai', name: l('関西', 'Kansai') },
    { id: 'region-kyushu', name: l('九州', 'Kyushu') },
    { id: 'region-tohoku', name: l('東北', 'Tohoku') },
  ],
  entities: [
    ...sites, ...people, ...customers, ...products, ...deals, ...deliverables, ...invoices,
    ...causes, ...issues, ...solutions, ...kpis, ...initiatives, ...suppliers, ...sources,
  ],
  flows: [
    { source: 'sup-steel', target: 'site-nagoya', valueT: 300 },
    { source: 'sup-steel', target: 'site-kitakyushu', valueT: 260 },
    { source: 'sup-steel', target: 'site-sendai', valueT: 100 },
    { source: 'sup-electronics', target: 'site-nagoya', valueT: 120 },
    { source: 'sup-electronics', target: 'site-kitakyushu', valueT: 40 },
    { source: 'sup-electronics', target: 'site-sendai', valueT: 70 },
    { source: 'sup-resin', target: 'site-nagoya', valueT: 100 },
    { source: 'sup-resin', target: 'site-kitakyushu', valueT: 60 },
    { source: 'sup-resin', target: 'site-sendai', valueT: 50 },
    { source: 'site-nagoya', target: 'site-yokohama-dc', valueT: 300 },
    { source: 'site-nagoya', target: 'site-osaka-dc', valueT: 220 },
    { source: 'site-kitakyushu', target: 'site-osaka-dc', valueT: 360 },
    { source: 'site-sendai', target: 'site-yokohama-dc', valueT: 220 },
    { source: 'site-yokohama-dc', target: 'region-kanto', valueT: 360 },
    { source: 'site-yokohama-dc', target: 'region-tohoku', valueT: 120 },
    { source: 'site-yokohama-dc', target: 'region-chubu', valueT: 40 },
    { source: 'site-osaka-dc', target: 'region-chubu', valueT: 180 },
    { source: 'site-osaka-dc', target: 'region-kansai', valueT: 260 },
    { source: 'site-osaka-dc', target: 'region-kyushu', valueT: 140 },
  ],
  optimization: {
    period: l('2026 年 10 月（1 か月）', 'October 2026 (one month)'),
    plants: [
      { siteId: 'site-nagoya', capacityT: 520, productionCostPerT: 182_000, co2PerT: 1.9 },
      { siteId: 'site-kitakyushu', capacityT: 380, productionCostPerT: 171_000, co2PerT: 2.3 },
      { siteId: 'site-sendai', capacityT: 300, productionCostPerT: 176_000, co2PerT: 1.6 },
    ],
    regionDemandT: [360, 220, 260, 140, 120],
    transportCostPerT: transport,
    leadTimeDays: [
      [2, 1, 1, 3, 3],
      [3, 2, 2, 1, 4],
      [1, 3, 3, 4, 1],
    ],
    co2TransportPerT: transport.map((row) => row.map((c) => Math.round(c * 0.000012 * 1000) / 1000)),
    currentAllocation: [
      [300, 220, 0, 0, 0],
      [0, 0, 260, 100, 0],
      [60, 0, 0, 40, 120],
    ],
  },
};
