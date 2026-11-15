# 経営・KPI/OKR・Project・解決策の結び付けの調査

この文書は FR-312〜FR-316（[要求定義書 §3.12](requirements-definition.md#312-経営kpiokrproject-の結び付けと最終成果物)）の手法の根拠です。依頼者の仮説「経営 → KPI/OKR → Project → 各アイテム」を、経営学・経営工学の一次文献で検証し、採用した表現と計算を記録します。実装は端末内の決定的な計算だけで、生成 AI と Azure の新しい資源は使いません（[判断資料 D-21](decision-guide.md)）。

**2026-11-16 補足:** 旧概要を戦略概要へ置き換え、全5段で事業目標→任意のOKR/KPI→課題→解決策の共通図と状況別の並び替えを示す（D-24）。図は等幅の関係図であり量の保存や因果を主張しない。AIによる最適化は独立用途 `strategyOverview` の送信確認・スキーマ/参照/数値検証・ドラフト・人の確定を経る。KPI実績・投資額・年間便益とシミュレーションは引き続きAIで変更しない。旧D-21の非AI実装はこれらの数値計算について維持する。手順は [利用者ガイド](../users-guide/02-orientation.md#copilotで最適化しドラフトを確定する)。

## 1. 結論

| 依頼者の仮説 | 調査の結果 | 採用した形 |
|---|---|---|
| 経営と KPI/OKR と Project を必ず結び付ける | 支持。戦略の実行の失敗の多くは、目標と日々の取り組みの間のつながりの欠落にある（Sull ほか 2015） | 経営目標 → OKR の目標 → 主要な結果（KR）/KPI → 解決策 → ユースケース・施策 → 成果物の 1 本の鎖（strategy thread）を Project ごとに作り、切れた箇所を数える |
| KPI と OKR は同じもの | 修正。KPI は継続して測る指標、OKR は期限付きの目標と、その達成を測る KR。KR の多くは KPI の目標値として書ける | KR が KPI を参照する形（`keyResult.kpiId`）。OKR にない KPI は「OKR に結び付いていない KPI」として欠落に数える |
| 解決策の貢献を数値で示す | 支持。ただし 1 点の数値は楽観に偏る（Lovallo & Kahneman 2003）。幅で見積もり、根拠の種類を残す | 「どれだけやるか（量）× 1 単位あたりの効果 × 期限までの立ち上がり」を 3 点見積もりのモンテカルロで計算し、P10/P50/P90 と目標の達成確率を出す |
| 最終成果物は要求定義書 | 修正。業務の課題はデジタル化だけでは解けない。業務・組織・設備・外部の変化には、それぞれ別の成果物がいる（Ward & Daniel、Kotter 1995） | 解決策の種類ごとに成果物を変える（下の §4） |
| 手順は 現状分析 → あるべき姿 → KPI/OKR → 解決策 | 支持。課題の定義は現状分析に含め、あるべき姿で経営目標とギャップを置き、ギャップを KPI/OKR に翻訳する | 5 ステップ（現状分析 → あるべき姿 → KPI/OKR 定義 → ソリューション作成 → 要求定義・計画） |

## 2. 結び付けの構造

### 2.1 戦略マップ（Kaplan & Norton）

Kaplan と Norton は、戦略を「財務・顧客・業務プロセス・学習と成長」の目標の因果の鎖として 1 枚に描く戦略マップを示した。目標どうしの「なぜ → どうやって」の矢印があることで、指標が目標から切り離されたダッシュボードにならない。BAS では企業分析の経営目標（`companyObjectives`）を鎖の根に置き、OKR の目標はどれかの経営目標に結び付くこととした（ToDo `tobe-link`・`kpi-company`）。

### 2.2 便益依存ネットワーク（Ward, Daniel & Peppard）

IT 投資の事業計画では、目的（investment objectives）→ 便益（business benefits）→ 業務の変化（business changes）→ それを可能にする変化（enabling changes）→ IT（IS/IT enablers）の右から左の依存を描く。便益は IT からではなく業務の変化から生まれ、変化には責任者と測定が要る。BAS ではこの考えで次を決めた。

- 解決策は「変化」であり、IT はその 1 種類にすぎない（§4 の 5 種類）。
- 解決策ごとに、どの KPI（便益）を動かすかと、その量を記録する（貢献）。
- 便益に結び付かない解決策と、解決策のない KPI は、どちらも鎖の切れとして数える（ToDo `dlv-trace`）。

### 2.3 OKR と方針管理

OKR（Doerr）と方針管理（Hoshin Kanri、Akao）は、上位の目標を下位の目標と測定に「キャッチボール」で展開する。OKR は 1 つの目標に 2〜5 個の測れる KR を置く。BAS では KR に KPI を参照させ、KPI の基準値・現状値・目標値・期限をそのまま KR の判定に使う。新しい指標を二重に持たない。

### 2.4 指標の選び方（Mauboussin）

Mauboussin は、目標に対して「持続的で、予測力があり、自分が影響できる」指標を選ぶべきで、測りやすい指標で代用しないよう指摘した。BAS は KPI ごとに定義・計算式・データの出所・頻度・責任者を求め（既存の KPI 定義書）、貢献の見積もりには根拠の種類（実測・ベンチマーク・専門家の判断・仮定）を残す。

## 3. 貢献のシミュレーション

### 3.1 式

1 つの貢献（解決策 s が KPI k を動かす）を次で表す。

```
期限での改善 = 量 × 1 単位あたりの効果 × 立ち上がりの割合(期限)
```

- **量:** 何をどれだけやるか（例: 新しい画面で入力する受注の割合 %、研修を受ける人数、導入する拠点数）。単位は利用者が書く。
- **1 単位あたりの効果:** その量 1 単位で KPI が目標の方向へどれだけ動くか。正の値が改善。KPI の望ましい方向（増やす・減らす）はアプリが当てる。
- **立ち上がり:** 効果が出始める日（`rampStart`）から全効果に達する日（`fullEffect`）まで直線で増える。KPI の期限の時点の割合だけを数える（便益の実現までの時間）。

量と効果はどちらも「下限・最頻値・上限」の 3 点で書く。Hubbard の校正された見積もり（90% の信頼区間を答える訓練）に合わせ、1 点ではなく幅で尋ねる。

### 3.2 計算

- 三角分布から量と効果を独立に引き、PARAM-155 = 2,000 回のモンテカルロで KPI の期限の値を計算する。乱数は種付きの mulberry32 で、同じ入力は常に同じ P10/P50/P90 を返す（再現でき、テストできる）。
- 1 つの KPI に複数の貢献があるときは足す。足してよいのは別の要因に働くときだけなので、複数の解決策が同じ KPI に効くときは「重なりの可能性」を警告し、二重計上を隠さない。
- 出す値: 期待値（三角分布の平均 × 立ち上がり）、P10/P50/P90（P10 は KPI の方向で悲観側）、期限までに目標に届く割合、P50 の改善が残りのギャップを埋める割合（カバー率）。

### 3.3 警告

| 警告 | 条件 | 根拠 |
|---|---|---|
| 過大見積もりの疑い | カバー率が PARAM-156 = 1.5 を超える（ギャップの 1.5 倍以上を埋めるという見積もり） | 計画の誤り（planning fallacy）。内側の視点の見積もりは楽観に偏る。参照クラス（似た過去の取り組みの実績）と比べるよう促す（Lovallo & Kahneman 2003、Flyvbjerg） |
| 重なり | 1 つの KPI に 2 つ以上の解決策 | 二重計上の防止 |
| 仮定だけ | すべての貢献の根拠が「仮定」 | 根拠のない数値を判断に使わない（D-10 の考え方と同じ） |
| 期限後 | 立ち上がりが KPI の期限より後 | 便益の実現時期 |
| 不正な幅 | 下限 ≤ 最頻値 ≤ 上限でない | その貢献を計算から外し、隠さず表示 |

### 3.4 しないこと

- 貢献の数値を生成 AI で作らない。数値は人が根拠とともに入力する（顧客パックの「値を作らない」と同じ規則）。
- 結果を「効果の保証」として表示しない。分布と根拠の種類を必ず並べる。

## 4. 解決策の種類と成果物

| 種類 | 例 | 最終成果物 | 主な節 |
|---|---|---|---|
| デジタル（`digital`） | 需要予測、外観検査、電子請求 | 要求定義書（ISO/IEC/IEEE 29148 の構成に合わせる） | 目的、範囲、利害関係者、業務要求（KR に結び付く）、機能要求（ユースケースから）、非機能要求、データ要求、制約、受け入れ基準（KPI の目標に結び付く）、便益、リスク、追跡表 |
| 業務プロセス（`process`） | 受注の流れの変更、標準作業 | 業務改革計画 | 現状と目標の業務、変更点、役割、移行、便益、リスク、追跡表 |
| 人・組織・制度（`people`） | 人事制度の改定、評価・報酬、組織変更 | 変革（チェンジ）計画 | 制度・方針の変更、影響、変革の進め方（Kotter の段階）、ガバナンス、便益、リスク、追跡表 |
| 設備・資産（`asset`） | 設備更新、省エネ機器 | 投資計画 | 投資内容、事業計画（回収）、調達、便益、リスク、追跡表 |
| 外部連携（`partner`） | 外部委託、提携 | 調達・提携計画 | 範囲、選定、契約、便益、リスク、追跡表 |

- 種類は人が確定する。確定前はデータから推定した種類を「推定」と表示する（ToDo `sol-type`）。
- 節の本文は、鎖のデータ（目標・KR・KPI・貢献・ユースケース・施策）から決定的に作る。データで言えないところは【要記入】とし、人が書くまで成果物を未完了とする（ToDo `dlv-docs`）。
- どの成果物も最後に追跡表（経営目標 → OKR → KPI → 解決策 → ユースケース・施策）を持つ。29148 の追跡可能性の要求を、デジタル以外にも同じ形で当てる。

## 5. KPI/OKR の定義の取得と作成

顧客がすでに KPI/OKR を定めているかどうかで進め方が変わる。顧客パックの `extensions.okr.definitionStatus` に次を記録する（FR-313）。

| 状態 | 意味 | アプリの動き |
|---|---|---|
| `defined` | 顧客の定義を資料から取得した（KR のある OKR がある） | 取り込んだ KPI/OKR を「顧客の定義」として使う。変えるときは顧客の合意を記録 |
| `partial` | 一部だけ取得した（KPI はあるが OKR がない等） | 取得した分を使い、足りない分の定義案を作る |
| `undefined` | 顧客に定義がないことを確認した | 現状分析・あるべき姿から定義案を作る |
| `notRetrieved` | 確認できなかった | 「ない」とはみなさない。取得の方法（確認した資料の一覧 `checkedSources`）を示し、取得を続けるか定義案を作る |

- 生成 AI の回答が「定義あり」と言っても中身がなければ、パックの中身から状態を付け直す（`stampKpiDefinition`）。証拠がないことを「定義がない」証拠としない。
- 公開 Web 調査は社内の KPI/OKR を持たないため、CLI の生成（`scripts/lib/generate.ts`）は `notRetrieved` を記録し、アプリで定義を促す。
- KPI/OKR には出どころ（顧客の定義・BAS で作った案）を表示し、顧客の定義を案で黙って上書きしない。

## 6. 画面での表現

- **ToDo 帯（全画面）:** 経営目標・OKR・KPI・解決策の件数と、鎖の切れの数を 1 行で示す。
- **成果物の画面:** 鎖の全体（ツリー）と切れの一覧、KPI/OKR の定義の状態、解決策の種類と貢献の入力・シミュレーション結果、解決策ごとの成果物。
- **企業と Project:** Project 行に、結び付いた経営目標と KPI の件数を示す。
- **分析の KPI/OKR:** KPI ごとに出どころ（顧客の定義・BAS の案）を示す。

## 7. 検証

| 確かめること | 検証先 |
|---|---|
| シミュレーションが決定的・再現可能で、警告が条件どおりに出る | `tests/strategy.test.ts` |
| 定義の状態の付け直し（矛盾・未記録・確認元） | `tests/strategy.test.ts` |
| 鎖の切れの検出、種類ごとの成果物の節と【要記入】 | `tests/strategy.test.ts`、`tests/project-deliverables.test.ts` |
| 旧ステップ（課題定義・ユースケース作成・施策計画）の保存データの読み替え | `tests/projects.test.ts` |
| 画面での入力・シミュレーション・成果物・再読み込み・アクセシビリティ | `e2e/project-deliverables.spec.ts` |

**未検証:** 見積もりの校正（入力した幅に実績が入る割合）は、実際の Project の実績がたまるまで測れない。警告のしきい値 1.5 は仮の値で、参照クラスの実績で見直す。

## 8. 出典

1. R. S. Kaplan, D. P. Norton, "Having Trouble with Your Strategy? Then Map It," *Harvard Business Review*, Sep–Oct 2000.
2. R. S. Kaplan, D. P. Norton, "The Balanced Scorecard—Measures That Drive Performance," *Harvard Business Review*, Jan–Feb 1992.
3. J. Ward, E. Daniel, J. Peppard, "Building Better Business Cases for IT Investments," *MIS Quarterly Executive*, 7(1), 2008.
4. D. Lovallo, D. Kahneman, "Delusions of Success: How Optimism Undermines Executives' Decisions," *Harvard Business Review*, Jul 2003.
5. D. Sull, R. Homkes, C. Sull, "Why Strategy Execution Unravels—and What to Do About It," *Harvard Business Review*, Mar 2015.
6. M. J. Mauboussin, "The True Measures of Success," *Harvard Business Review*, Oct 2012.
7. J. P. Kotter, "Leading Change: Why Transformation Efforts Fail," *Harvard Business Review*, Mar–Apr 1995.
8. D. W. Hubbard, *How to Measure Anything*, Wiley（校正された見積もり・モンテカルロ）.
9. J. Doerr, *Measure What Matters*, Portfolio, 2018（OKR）.
10. Y. Akao (ed.), *Hoshin Kanri: Policy Deployment for Successful TQM*, Productivity Press, 1991.
11. ISO/IEC/IEEE 29148:2018, *Systems and software engineering — Life cycle processes — Requirements engineering*.
