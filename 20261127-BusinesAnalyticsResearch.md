# 戦略コンサルタントは Issue list をどう評価しているか — 一次資料の調査と Business Analytics Studio の分析手法の監査

調査日: 2026-11-27（JST）。監査対象: コミット `3da6437` の作業ツリー。
根拠の強さの表記: **A** 査読付き実証研究、**B** 査読付き概念論文、**C** 実務家の論考（HBR・コンサルティング会社）、**D** 書籍。出典の一覧は末尾にあります。

---

## 要旨

1. **パートナー級の Issue list は「課題の一覧」ではなく「判断すべき少数の論点」です。** Rumelt は「長いやることリストは戦略ではない。ただのやることリストだ」（McKinsey Quarterly 2011、原文で確認）として、集めた項目をすべて計画に入れることを悪い戦略の典型とし、「克服でき、かつ最大の前進をもたらす」1〜2 個の crux に絞ることを求めます（C・D）。Kepner-Tregoe は「まず少数の重大な懸念を特定」してから評価します（C）。Bain・Marakon のパートナーによる大企業 156 社の調査も、成果を出す企業は「少数の重要テーマ」に絞った継続的な意思決定をしていると報告しています（C）。
2. **評価軸は、出典をまたいで 4 つの核に収れんします。**
   - 影響度（重大性）
   - 緊急度
   - 拡大性（放置したときの悪化）
   - 実現可能性・制御可能性

   これに「根拠の確からしさ」「戦略との整合」「脅威か機会か」「構造上の位置（症状か原因か、共通原因か）」が加わります。
3. **軸の組み合わせ方は、加算ではなく「関門」です。** Ansoff（1980）は、影響度 × 緊急度の表から「リストから外す／監視／遅らせて計画／即応」という**対応の種類**を決めます（B）。Dutton & Duncan（1987）では、緊急度と実現可能性の**両方**がそろって初めて変化の勢いが生まれます（B）。Rumelt の crux は「重要」**かつ**「克服可能」です。どれも、一方の高さで他方の低さを埋め合わせることを許しません。
4. **緊急度は「主観の 1〜5」ではなく、時間の比較で決まります。** Ansoff は、緊急度を「影響が出る時期」と「対応に要する時間」の見積もりを比べて決めると定義しています（原文で確認）。
5. **BAS（このアプリ）の監査結果**
   - **強み:** 課題の見極め（Khalsa & Illig）、出典・原因・KPI・基準値の完了条件、SCQA の要約、順位の確からしさ（SMAA）と情報価値（EVPPI）、遅延コスト（CD3）は、実務の水準を上回る部分があります。
   - **中心の欠落:** 一方で、Projectパックの課題は**影響度と実現性の 2 軸の加算**だけで順位が決まります。緊急度・拡大性・事業の状況・構造（共通原因）を持たないため、サンプルの「熟練技能の継承（5 年で熟練者の 3 割が退職）」は、影響度 × 実現性でも CD3 でも**最下位**になります。Ansoff の定義では、対応に年単位を要する課題は早く着手すべき候補です。
   - **算出上の誤り:** 業務分析レポート側では、レポートの 1 つの優先度が**影響度と緊急度の両方に入り**、点数の 5/6 を占めています。
6. **改善の推奨順:**
   1. レポート側の緊急度の二重計上を直す（小さく、確実）
   2. 緊急度と拡大性を、時間とデータで導く
   3. 影響度の低い課題を外す関門を入れる
   4. 評価尺度の定義と【仮評価】の不確かさを反映する
   5. 事業状況の類型で既定の重みを切り替える
   6. 共通原因（crux 候補）を検出する

---

## 1. 調査の範囲と限界

- **大手ファームの社内手法は公開されていません。** 本調査は、パートナー経験者が書いたもの（Minto、Conn & McLean、Mankins、Rumelt など）、ファームの公開論考、戦略論の学術研究（strategic issue diagnosis、problem formulation）から再構成しています。「パートナーが実際に毎回こうしている」ことを示す実証データはありません。
- **実務家の文献（C・D）は経験則です。** 学術研究（A・B）は軸の存在と作用を示しますが、多くは概念論文です。実証は Jackson & Dutton（1988）、Thomas ほか（1993）、Camuffo ほか（2020）に限られます。
- **出典の確認状況:** 有料記事（HBR 本文、JSTOR 本文）は要約・抄録・出版社ページで確かめました。全文で確かめられなかった箇所は「要約で確認」と書きます。McKinsey の 7 ステップの記事は検索の抜粋でしか読めませんでした。

## 2. 「Issue」の 2 つの意味

| 意味 | 定義 | 出典 | 例 |
|---|---|---|---|
| **戦略的課題（strategic issue）** | 業績に影響し得る、内外の動きや事象 | Ansoff 1980（B）、Dutton, Fahey & Narayanan 1983（B） | 電力単価の上昇、熟練者の大量退職 |
| **論点（key question）** | 答えが意思決定を変える問い | Minto の SCQ（Situation → Complication → Question）（D）、Conn & McLean の問題定義（C）、Mankins & Steele の「issue に焦点を当てた意思決定」（C） | 「受注から出荷までを競合並みにするために、計画の一元化と在庫の統合のどちらに先に投資すべきか」 |

パートナーは前者を素材に集め、後者に変換してから評価します。Dutton, Fahey & Narayanan（1983）は、診断の出力を「前提・因果の理解・予測」としています。つまり、課題は**症状の記述では終わらず、因果と予測を伴う判断の対象**になって初めて評価の単位になります。

## 3. ビジネス状況の類型 — 状況が評価軸の重みを変える

### 3.1 一次資料にある類型

| 類型 | 分け方 | 出典（根拠） |
|---|---|---|
| **STARS** | 立ち上げ（start-up）、立て直し（turnaround）、急成長（accelerated growth）、再編（realignment）、成功の維持（sustaining success） | Watkins, HBR 2009（C）。本来はリーダーの着任時の状況の分類 |
| **戦略パレット** | 環境の予測可能性 × 変えられる度合いで、classical・adaptive・visionary・shaping。厳しい環境では renewal（再生） | Reeves, Love & Tillmanns, HBR 2012（C）、BCG Strategy Palette（C） |
| **成長段階と危機** | 創造性 → 指揮 → 委譲 → 調整 → 協働。各段階の終わりに組織の危機が来る | Greiner, HBR 1972/1998（C） |
| **戦略的課題の解釈** | 脅威か機会か、損失か利得か、制御できるか | Jackson & Dutton 1988（A）、Thomas, Clark & Gioia 1993（A） |

### 3.2 状況ごとに重くなる軸（本調査の統合。出典の組み合わせによる仮説で、直接の実証はない）

| 状況 | 最も重い軸 | Issue list の形 | 主な根拠 |
|---|---|---|---|
| 立て直し・再生（turnaround / renewal） | **緊急度**（資金・存続）。次に制御可能性 | 短い。現金と費用の論点に集中し、それ以外は「監視」に回す | Ansoff の「即応」セル、BCG の renewal、Watkins |
| 再編（問題に向かいつつあるが組織が認識していない） | **問題の定義と合意**（再定義、論点の持ち上げ） | 「本当の問題は何か」を複数の枠組みで書き直す。経営陣の注意を得られる論点に絞る | Wedell-Wedellsborg 2017、Dutton & Ashford 1993、Watkins |
| 急成長 | **拡大性**（規模に追いつかない能力、組織の危機） | 次の成長段階で壊れるものを先に挙げる | Greiner、Kepner-Tregoe の Growth |
| 成功の維持 | **弱いシグナルの監視**（影響度は大、緊急度は低） | 「監視リスト」と「着手リスト」を分ける | Ansoff の弱いシグナルの管理 |
| 立ち上げ・新規事業 | **仮説の確からしさ**（何が真であるべきか） | 論点ごとに検証の実験を置く | Lafley ほか 2012、Camuffo ほか 2020（A、ただし対象はスタートアップ） |
| 予測しにくい環境（adaptive / shaping） | **情報の価値**（何を確かめれば判断が変わるか） | 順位は暫定とし、学習を前提に頻繁に見直す | Reeves ほか、Howard 1966 |

要点: **状況を決めずに重みを決めることはできません。** 同じ「影響度 60／実現性 40」は、立て直しの局面では緊急度を見落とします。成功を維持している局面では、監視すべき大きな課題を「実現性が低い」として下位に送ります。

## 4. 評価軸 — 出典ごとの比較と統合ルーブリック

### 4.1 一次資料の軸

| 出典 | 軸 | 組み合わせ方 | 強さ |
|---|---|---|---|
| Ansoff 1980, SMJ | 影響度（低・中・大）× 緊急度（低・中・切迫） | 表の 9 つのセルから対応を決める。大 × 切迫は「即応」、低 × 低は「リストから外す」、大 × 低は「継続監視」。**緊急度は、影響が出る時期と対応に要する時間の比較**で決める | B（原文の抜粋で確認） |
| Dutton & Duncan 1987, SMJ | 緊急度・実現可能性 | 両方がそろうと変化の勢いが最大。緊急度が低いと課題は休眠する | B |
| Kepner-Tregoe（Situation Appraisal） | Seriousness（今の影響）、Urgency（すぐ解決する必要）、Growth（長期の影響・悪化） | まず少数の重大な懸念を選び、それだけを 3 軸で評価する。懸念を「問題（原因不明）／決定／潜在的問題」に分ける | C（公式資料で確認） |
| Conn & McLean（McKinsey 7 ステップ） | レバーの重要度、レバーを動かせる度合い | ロジックツリーで分解し、両方が大きい枝に集中する | C（抜粋で確認） |
| Rumelt 2011 / 2022 | 重要性 × 克服可能性 | 両方を満たす 1〜2 個の crux に絞る | C・D |
| Jackson & Dutton 1988 / Thomas ほか 1993 | 脅威か機会か、損失か利得か、制御可能性 | 解釈によって、情報の使い方と行動が変わる | A |
| Dutton & Ashford 1993 | 戦略的な関連（長期の業績との関係）、経営陣が解決できると見えるか | 経営陣の注意を得るための論点の枠組み | B |
| Spradlin 2012, HBR | 必要の確立、戦略との整合、誰が実行するか、制約、成功の測り方 | 問題の記述の質が解の質を決める | C |
| Wedell-Wedellsborg 2017, HBR | 再定義（外部の視点、目的を問う、うまくいっている例外を見る など 7 つ） | 経営者の 85% が「問題の診断が下手」と回答（106 人） | C（小規模調査） |
| Baer, Dirks & Nickerson 2013, SMJ | 問題の定式化の過程 | 異質なチームが構造化された共同の問いを通じて定式化する | B |
| Mankins & Steele 2006, HBR | 意思決定に直結するか | 年次・事業部単位の計画をやめ、少数のテーマについて継続的に決める（156 社の調査） | C（要約で確認） |

### 4.2 統合ルーブリック（監査の基準）

| # | 軸・基準 | 問い（パートナーが Issue list を読むときの問い） | 主な根拠 |
|---|---|---|---|
| R1 | 影響度（重大性） | 解かないと、何に、どれだけ効くか | Ansoff、KT、Conn & McLean |
| R2 | 緊急度 | 影響が出るまでの時間と、対応に要する時間は、どちらが長いか | Ansoff（定義）、KT、Dutton & Duncan |
| R3 | 拡大性・不可逆性 | 放置すると悪化するか、取り返しがつかなくなるか | KT の Growth |
| R4 | 実現可能性・制御可能性 | 自社が動かせるレバーか、手段と権限はあるか | Dutton & Duncan、Jackson & Dutton、Rumelt |
| R5 | 関門型の組み合わせ | 影響度の低い課題をリストから外しているか。高い点を足して埋め合わせていないか | Ansoff の表、Dutton & Duncan、Rumelt |
| R6 | 状況への適合 | 事業の状況に合った軸の重みか | Watkins、Reeves ほか、Greiner |
| R7 | 根拠の確からしさ | 事実か仮説か、評価のばらつきはどの程度か | Dutton ほか 1983、Kahneman ほか 2016 |
| R8 | 構造（症状か原因か・共通原因） | 症状と原因を分けているか。複数の課題に効く原因（crux 候補）はどれか | KT の問題分析、Conn & McLean、Rumelt、Minto |
| R9 | 論点化・意思決定との結び付き | 課題は答えるべき問いになっているか、誰が決めるか | Minto、Spradlin、Mankins & Steele |
| R10 | 枠組みの見直し | 別の枠組みで書き直したか、目的そのものを問うたか | Wedell-Wedellsborg、Baer ほか |
| R11 | 脅威か機会か | 機会も Issue list に載っているか | Jackson & Dutton、Ansoff |
| R12 | 少数への絞り込み | 実際に着手するのは数件に絞られているか | Rumelt、KT、Mankins & Steele |

## 5. 監査: BAS の分析手法をルーブリックで照合

### 5.1 BAS が Issue を扱う 2 つの系統

| 系統 | データ | 順位の付け方 | 実装 |
|---|---|---|---|
| **Projectパックの課題** | `impact`（1〜5）、`feasibility`（1〜5）、`causeIds`、`kpiIds`、`sourceIds` | `(impact−1)/4` と `(feasibility−1)/4` を 60:40 で加算して 0〜100 点にする。さらに 4 象限、SMAA と EVPPI、CD3 | [src/data/schema.ts:104](src/data/schema.ts)、[src/domain/priority.ts:15](src/domain/priority.ts)、[src/domain/summary.ts:7](src/domain/summary.ts)、[src/modules/project/priorityAnalysis.ts:135](src/modules/project/priorityAnalysis.ts) |
| **業務分析レポート（M365 Copilot）の課題** | `priority`（1〜3）、現象、真因、影響、反証条件、根拠ラベル | 影響度・緊急度・確からしさを 3:2:1 で加重平均する | [src/data/extensionSchemas.ts:368](src/data/extensionSchemas.ts)、[src/modules/project/decisionSupport.ts:125](src/modules/project/decisionSupport.ts) |

### 5.2 強み（ルーブリックを満たす、または超える点）

| 基準 | 実装 | 評価 |
|---|---|---|
| R7 根拠 | 現状分析の完了条件で、課題ごとに出典・原因・KPI・基準値・原因の出典を確かめる（[deliverables.ts:623](src/modules/project/deliverables.ts)） | 実務の水準を上回る。根拠のない課題が先に進めない |
| R12・R9 見極め | Khalsa & Illig による「取り組む／今は取り組まない／取り組まない」の判定。「取り組む」なら「今回は何が違うか」を必須にしている（[deliverables.ts:63](src/modules/project/deliverables.ts)、[deliverables.ts:703](src/modules/project/deliverables.ts)） | Rumelt や Mankins & Steele の「絞る」の実装として妥当。「いいえ」も成果として残す |
| R7 ばらつき | SMAA で 1 位が 1 位になる割合を出し、EVPPI で次に確かめる 1 つを示す（[docs/prioritization-method-study.md](docs/prioritization-method-study.md)） | パートナーが口頭で行う「この順位はどれくらい固いか」を定量化している |
| R2 の一部 | CD3（遅延コスト ÷ 期間）で、待ちで失う価値が最も小さい順を示す | 金額があれば緊急度を部分的に表せる |
| R9 論点化（段のレベル） | 段の要約を SCQA とピラミッドで書き、数値は事実台帳からのみ出す（[stepBrief.ts:15](src/modules/project/stepBrief.ts)） | Minto の構造に沿う |
| R8 原因（記述） | 「真因（なぜなぜの結論。確かめるまでは仮説）」「事実とデータ」「データの不足」の欄（[dlv.ja.ts:340](src/i18n/modules/dlv.ja.ts)） | 記述欄としては十分 |
| R10・仮説 | あるべき姿で「実現の前提（何が真であるべきか）」を書く（[dlv.ja.ts:333](src/i18n/modules/dlv.ja.ts)） | Lafley ほかの手法に沿う |
| R7 レポート側 | 【事実】【仮説】【要確認】の根拠ラベルと反証条件（`falsifier`）を読み取る | 仮説と事実の区別がデータになっている |

### 5.3 欠落と誤り（重大度順）

#### G1【高】業務分析レポート側で、1 つの優先度が影響度と緊急度の両方に入っている

- **証拠:** [decisionSupport.ts:130-131](src/modules/project/decisionSupport.ts) では、`impact` と `urgency` の両方が `ordinalTo5(issue.priority)` です。レポートの課題は `priority` を 1 つしか持ちません（[extensionSchemas.ts:371](src/data/extensionSchemas.ts)）。既定の重みは影響度 3・緊急度 2・確からしさ 1 です（[decisionSupport.ts:63](src/modules/project/decisionSupport.ts)）。
- **再現:** 根拠が同じ【事実】で、優先度が 3 と 1 の課題は 4.833 点と 1.500 点になりました。点数の 5/6 が同じ 1 つの値から来ています。さらに、緊急度の出所が「レポート」と表示されますが、レポートは緊急度を述べていません。
- **なぜ問題か:** Ansoff と KT は、影響度と緊急度を**別の軸**として扱います（大 × 低の課題は「監視」で、「即応」ではない）。今は軸を 3 つ持つように見えて、実際は 2 軸です。出所の表示も、事実と異なります。
- **改善:** レポートが期限・時期を述べていない限り、緊急度は「未評価（3、出所は unrated）」とします。
- **受け入れ基準:** 優先度だけを持つレポートの課題で `ratings.urgency.origin === 'unrated'` になること。重みを緊急度だけにすると、全課題が同点になること。

#### G2【高】Projectパックの課題に、緊急度と拡大性の軸がない

- **証拠:** 課題のスキーマは `impact`・`feasibility`・`causeIds`・`kpiIds` だけです（[schema.ts:104-110](src/data/schema.ts)）。
- **再現:** サンプルの「熟練技能の継承」（5 年で熟練者の 3 割が退職、影響度 4・実現性 2）は 55 点で 5 件中 5 位です。CD3 の順でも 5 位です（CD3 は約 47 万円/月で最小。[prioritization-method-study.md](docs/prioritization-method-study.md) §8.5）。
- **なぜ問題か:**
  - Ansoff は緊急度を「影響が出る時期と対応に要する時間の比較」で決めます。暗黙知の継承は、育成に年単位を要し、退職後は取り返せません（KT の Growth、不可逆）。このような課題は、影響が 5 年先でも、今着手しないと間に合わない可能性があります。
  - CD3 は月あたりの損失が一定であることを前提にしていて、期限で価値が急に失われる形を扱えません。これは既存の調査も限界として認めています（[prioritization-method-study.md](docs/prioritization-method-study.md) §8.6）。
- **改善:**
  1. 任意の項目「影響が出るまでの月数」「対応に要する月数」を課題に加えます。対応 ≥ 影響の課題には、Ansoff の「即応」または「遅らせて計画」を示します。値がない課題は「未評価」と表示し、推定で埋めません。
  2. 拡大性は、すでにあるデータから導きます。KPI の基準値 → 現状値と、向き（増やす／減らす）から悪化の傾向を出せます（[schema.ts:121-134](src/data/schema.ts)）。
- **受け入れ基準:**
  - サンプルの熟練技能の継承に「影響まで 60 か月、対応 36 か月以上」を入れると、緊急度の区分が上がり、順位表に「対応の着手期限」が出ること。
  - 悪化している KPI を持つ課題に「悪化中」と表示されること（決定的な単体テスト）。

#### G3【高】加算型のスコアで、影響度の低い課題が残る

- **証拠:** [priority.ts:15-20](src/domain/priority.ts) の加重和です。
- **再現:** 影響度 1・実現性 5 の課題と、影響度 3・実現性 2 の課題が、どちらも 40 点で並びました。
- **なぜ問題か:** Ansoff の表では、影響度が低い課題は「リストから外す」か「定期確認」です。Dutton & Duncan や Rumelt も、両方の条件を満たすことを求めます。「簡単だから」という理由で影響度の低い課題が上位に残ると、Rumelt が批判する「全部入りの計画」になります。4 象限（[priorityAnalysis.ts:85](src/modules/project/priorityAnalysis.ts)）は表示されますが、順位そのものは加算のままです。
- **改善:** 順位の前に関門を置きます。影響度 ≤ 2 の課題は「定期確認」の区分に分け、着手の順位から外します。順位表には Ansoff 型の対応区分（即応／遅らせて計画／監視／外す）を主に表示し、点数は区分内の並べ替えに使います。
- **受け入れ基準:** 影響度 1・実現性 5 の課題が、着手順位の候補に出ず、「定期確認」に分類されること。既存の SMAA、EVPPI、CD3 は区分内の候補に対して計算されること。

#### G4【中〜高】評価尺度に定義がなく、【仮評価】の 3 が「根拠あり」として扱われる

- **証拠:**
  - スキーマは 1〜5 の範囲だけで、各段の意味を定めていません（[docs/pack.schema.json:1212-1221](docs/pack.schema.json)）。
  - 生成の規則は、根拠がなければ暫定で 3 とし【仮評価】と書く、というものです（[packGenerate.ts:606](src/modules/project/packGenerate.ts)）。
  - 一方、SMAA の揺らぎの幅は、`sourceIds` と `kpiIds` が空かどうかだけで決まります（[priorityAnalysis.ts:167-168](src/modules/project/priorityAnalysis.ts)、[priorityRobustness.ts:32-33](src/modules/project/priorityRobustness.ts)）。
- **なぜ問題か:** 利用者の文章（`source-brief-1`）から作った課題は、課題が**存在すること**の出典を持ちます。しかし影響度が 3 である根拠ではありません。それでも「根拠あり」と見なされ、揺らぎが小さく計算されます。Kahneman ほか（2016）は、評価者間のばらつきを減らすには共通の基準（reasoned rules）が要るとしています。定義のない 1〜5 は、人や AI ごとに意味が変わります。
- **改善:**
  1. 影響度・実現性の各段に、金額・KPI の差・範囲などで定義を置きます（パックの作成規則と画面のヒントに同じ定義を使います）。
  2. 【仮評価】の課題は、出典があっても「根拠なし」の幅（PARAM-192 の ±1.5）で揺らします。
- **受け入れ基準:** 【仮評価】の課題を含むパックで、その課題の根拠の水準が `none` と判定され、1 位の確からしさが下がること（単体テスト）。

#### G5【中】事業の状況類型がなく、重みが固定である

- **証拠:**
  - 会社のデータは名前と業種だけです（[schema.ts:206](src/data/schema.ts)）。
  - 重みは 60:40 に固定されています（[summary.ts:7](src/domain/summary.ts)、[priorityAnalysis.ts:135](src/modules/project/priorityAnalysis.ts)）。
  - SWOT は「改善（turnaround）」などの戦略類型を計算します（[analysis.ts:118](src/modules/project/analysis.ts)）。しかし、その結果は課題の重みに使われていません。
- **なぜ問題か:** §3.2 のとおり、状況によって最も重い軸が変わります。立て直しの局面で緊急度を見ない、成功を維持している局面で監視リストがない、といったずれが起きます。
- **改善:** Project に「状況」（STARS の 5 つ。任意、既定は未選択）を持たせ、状況ごとに既定の重みと表示する軸を切り替えます。SWOT の類型は候補として提案するだけにし、決めるのは人です。
- **受け入れ基準:** 状況が「立て直し」だと緊急度の重みが最大になること。未選択なら今の 60:40 と同じ順位になること（回帰テスト）。

#### G6【中】共通原因（crux 候補）と Issue tree がない

- **証拠:**
  - 原因（cause）は共通項目だけの平らなリストで、親子を持ちません（[schema.ts:111](src/data/schema.ts)）。
  - 課題は 1 件ずつ独立に順位が付きます。
  - 5 つの分析と課題の結び付きは、名前の文字列一致だけです（[analysisLinks.ts:7-11](src/modules/project/analysisLinks.ts)）。
- **なぜ問題か:** Rumelt の crux は、多くの課題の結び目になる 1 点です。KT の問題分析や McKinsey のロジックツリーは、症状を原因に分解し、レバーの大きい枝を選びます。課題を独立に足し合わせると、「複数の課題に効く 1 つの原因」が見えません。
- **改善:** 2 件以上の課題に共通する原因を検出し、その課題の影響度の合計で並べて「crux 候補」として示します（決定的な計算で、AI は使いません）。原因に任意の親（`parentCauseId`）を持たせ、分解が MECE かどうかは人が確かめます。
- **受け入れ基準:** 2 件の課題が同じ原因を参照するパックで、その原因が crux 候補の 1 位に出ること。共通の原因がなければ「共通原因なし」と表示し、候補を作らないこと。

#### G7【中】課題が「論点（問い）」と「決める人」になっていない

- **証拠:** 課題は症状の記述（例:「受注から出荷までが長い」[sample.ts:84](src/data/sample.ts)）です。問いと意思決定者は、課題ごとには持っていません。SCQA は段の要約のレベルだけ（[stepBrief.ts:15](src/modules/project/stepBrief.ts)）、課題ステートメントは文書の欄だけです（[dlv.ja.ts:323](src/i18n/modules/dlv.ja.ts)）。
- **なぜ問題か:** Minto、Spradlin、Mankins & Steele は、論点を「答えが決定を変える問い」と「決める人」に結び付けます。問いがないと、優先順位は「何を解くか」までで止まり、「何を決めるか」に届きません。
- **改善:** 取り組むと判定した課題に、任意の「答えるべき問い」と「決める人（役職）」を加えます。業務分析レポートの反証条件（`falsifier`）も、パックの課題に引き継げるようにします。
- **受け入れ基準:** 取り組む課題のうち問いのないものが、現状分析の ToDo に「論点未設定」として出ること（自動チェックではなく注意喚起から始める）。

#### G8【低〜中】Issue list に機会がない（脅威か機会か）

- **証拠:** 課題（issue）は問題だけを表します。機会は SWOT の項目にしかありません（[analysis.ts:7](src/modules/project/analysis.ts)）。
- **なぜ問題か:** Ansoff の戦略的課題は機会と脅威の両方を含みます。Jackson & Dutton と Thomas ほかは、課題を脅威と読むか機会と読むかで、情報の使い方と行動が変わることを実証しています（A）。
- **改善:** 課題に任意の `frame: 'threat' | 'opportunity'` を持たせ、順位表で区別して示します。

#### G9【低】方法カタログの根拠

- **証拠:** 影響度 × 実現性の方法の根拠は d.school、IDEO、RICE（実務ブログ）です（[priorityAnalysis.ts:50](src/modules/project/priorityAnalysis.ts)）。
- **改善:** G1〜G3 を実装するときに、Ansoff 1980、Dutton & Duncan 1987、Kepner-Tregoe を根拠に加えます。根拠の強さ（B・C）も表示します。

### 5.4 照合の要約

| 基準 | Projectパック系統 | 業務分析レポート系統 |
|---|---|---|
| R1 影響度 | ○（定義なし。G4） | △（緊急度と同じ値。G1） |
| R2 緊急度 | ×（CD3 で金額がある場合のみ部分的。G2） | ×（実質は影響度。G1） |
| R3 拡大性 | ×（KPI の傾向から導けるが未使用。G2） | × |
| R4 実現可能性 | ○ | ○（容易さ・費用・安全性は選択肢側） |
| R5 関門型 | ×（加算。G3） | ×（加重平均） |
| R6 状況への適合 | ×（G5） | × |
| R7 根拠の確からしさ | ◎（SMAA・EVPPI。ただし【仮評価】の扱いに穴。G4） | ○（根拠ラベル） |
| R8 構造 | △（原因は記述と参照のみ。G6） | △（現象と真因を分けて読む） |
| R9 論点化 | △（段のレベルのみ。G7） | △ |
| R10 枠組みの見直し | △（方法カタログに framing がある） | — |
| R11 脅威か機会か | ×（G8） | × |
| R12 絞り込み | ◎（見極めの判定） | ○ |

◎ 実務の水準を上回る ／ ○ 満たす ／ △ 一部 ／ × 欠落

## 6. 改善の順序

Ansoff の考え方を、この改善リスト自体に当てはめました（影響度 × 緊急度 × 実現性）。

| 順 | 項目 | 理由 |
|---|---|---|
| 1 | G1 緊急度の二重計上を直す | 算出の誤りで、出所の表示も事実と異なる。変更は小さく、回帰テストで確かめられる |
| 2 | G2 緊急度・拡大性 | 中心の欠落。拡大性は今のデータ（KPI の推移）だけで出せる |
| 3 | G3 関門型の区分 | G2 の緊急度がそろうと、Ansoff の表を完全に再現できる |
| 4 | G4 尺度の定義と【仮評価】 | 生成規則と揺らぎの計算の小さな変更で、順位の確からしさが正しくなる |
| 5 | G6 共通原因（crux 候補） | 今のデータ（`causeIds`）だけで計算できる |
| 6 | G5 状況類型 | 利用者の選択（UI）と重みの既定値の設計が要る |
| 7 | G7・G8・G9 | 任意項目の追加と出典の整備 |

要求番号は、採番の手順に従って実装時に振ってください。本書は番号を作りません。

## 7. 第三者による確認方法

1. **出典:** 末尾の URL で原文、抄録、出版社ページを開けます。Ansoff の緊急度の定義と影響度 × 緊急度の表は、JSTOR の該当ページの本文抜粋にあります。
2. **コード:** §5 の `パス:行` を開けば、各判定を誰でも確かめられます。
3. **数値の再現:** 次のテストを `tests/` に一時的に置き、`npx vitest run <ファイル>` で実行すると、本書の数値（80・75・70・60・55 点、40 点の同点、4.833 点と 1.500 点、CD3 の 1 位）を出力します。

```ts
import { it } from 'vitest';
import { samplePack } from '../src/data/sample.ts';
import { rankIssues } from '../src/domain/priority.ts';
import { DEFAULT_WEIGHTS } from '../src/domain/summary.ts';
import { emptyDecisionInputs, rankIssues as rankReportIssues } from '../src/modules/project/decisionSupport.ts';
import { analyzePackPriority } from '../src/modules/project/priorityAnalysis.ts';

it('reproduce', () => {
  const issues = samplePack.entities.filter((e) => e.kind === 'issue');
  console.log(rankIssues(issues as never, DEFAULT_WEIGHTS).map((r) => `${r.rank} ${r.issue.id} ${r.score}`));
  console.log(analyzePackPriority(samplePack.entities as never, samplePack.extensions as never).costOfDelay?.top);
  console.log(rankIssues([{ id: 'issue-a', impact: 1, feasibility: 5 }, { id: 'issue-b', impact: 3, feasibility: 2 }] as never, DEFAULT_WEIGHTS));
  const report = { issues: [
    { id: 'issue-1', title: 'A', priority: 3, evidence: ['fact'], text: '' },
    { id: 'issue-2', title: 'B', priority: 1, evidence: ['fact'], text: '' },
  ] };
  console.log(rankReportIssues(report as never, emptyDecisionInputs()).map((r) => [r.id, r.ratings.urgency, r.score]));
});
```

4. **改善後の確認:** §5.3 の各「受け入れ基準」は、決定的な単体テストとして書ける形にしてあります。

## 8. 限界

- §3.2 の「状況 → 重い軸」の表は、複数の出典を組み合わせた仮説です。状況ごとに重みを変えると判断が良くなることを示した実証研究は、見つけられませんでした。実装後は、利用者の判定（取り組む／取り組まない）と後の結果を記録して確かめる必要があります。
- 戦略的課題の診断研究の多くは、概念論文（B）です。実証（A）は「脅威か機会か・制御可能性」の解釈と、仮説駆動の意思決定（スタートアップ対象）に限られます。
- Watkins の STARS は、本来は着任するリーダーの状況の分類です。会社の状況の分類に使うのは転用です。
- 大手ファームの社内の評価シートは公開されていないため、パートナーの実際の作業との一致は検証できません。

---

## 出典

### 学術論文

- Ansoff, H. I. (1980). Strategic issue management. *Strategic Management Journal*, 1(2), 131–148. <https://www.jstor.org/stable/2486096> 、抄録 <https://ideas.repec.org/a/bla/stratm/v1y1980i2p131-148.html>
- Dutton, J. E., Fahey, L., & Narayanan, V. K. (1983). Toward understanding strategic issue diagnosis. *Strategic Management Journal*, 4(4), 307–323. <https://www.jstor.org/stable/2485923>
- Dutton, J. E., & Duncan, R. B. (1987). The creation of momentum for change through the process of strategic issue diagnosis. *Strategic Management Journal*, 8(3), 279–295. <https://ideas.repec.org/a/bla/stratm/v8y1987i3p279-295.html>
- Jackson, S. E., & Dutton, J. E. (1988). Discerning threats and opportunities. *Administrative Science Quarterly*, 33(3), 370–387. <https://www.jstor.org/stable/2392714>
- Thomas, J. B., Clark, S. M., & Gioia, D. A. (1993). Strategic sensemaking and organizational performance. *Academy of Management Journal*, 36(2), 239–270. <https://doi.org/10.2307/256522>
- Dutton, J. E., & Ashford, S. J. (1993). Selling issues to top management. *Academy of Management Review*, 18(3), 397–428. <https://www.jstor.org/stable/258903>
- Nickerson, J., Yen, C. J., & Mahoney, J. T. (2012). Exploring the problem-finding and problem-solving approach for designing organizations. *Academy of Management Perspectives*, 26(1), 52–72. <https://journals.aom.org/doi/abs/10.5465/amp.2011.0106>
- Baer, M., Dirks, K. T., & Nickerson, J. A. (2013). Microfoundations of strategic problem formulation. *Strategic Management Journal*, 34(2), 197–214. <https://www.jstor.org/stable/23362696>
- Camuffo, A., Cordova, A., Gambardella, A., & Spina, C. (2020). A scientific approach to entrepreneurial decision making: Evidence from a randomized control trial. *Management Science*, 66(2), 564–586. <https://www.jstor.org/stable/48811833>
- Howard, R. A. (1966). Information Value Theory. *IEEE Transactions on Systems Science and Cybernetics*, 2(1), 22–26. <https://doi.org/10.1109/TSSC.1966.300074>

### 実務家の論考（HBR・コンサルティング会社）

- Mankins, M. C., & Steele, R. (2006). Stop Making Plans; Start Making Decisions. *Harvard Business Review*, January 2006. <https://hbr.org/2006/01/stop-making-plans-start-making-decisions>
- Watkins, M. D. (2009). Picking the Right Transition Strategy. *Harvard Business Review*, January 2009. <https://hbr.org/2009/01/picking-the-right-transition-strategy>
- Reeves, M., Love, C., & Tillmanns, P. (2012). Your Strategy Needs a Strategy. *Harvard Business Review*, September 2012. <https://hbr.org/2012/09/your-strategy-needs-a-strategy> 、BCG Strategy Palette <https://www.bcg.com/capabilities/corporate-finance-strategy/strategy-palette>
- Greiner, L. E. (1972/1998). Evolution and Revolution as Organizations Grow. *Harvard Business Review*. <https://hbr.org/1998/05/evolution-and-revolution-as-organizations-grow>
- Spradlin, D. (2012). Are You Solving the Right Problem? *Harvard Business Review*, September 2012. <https://hbr.org/2012/09/are-you-solving-the-right-problem>
- Wedell-Wedellsborg, T. (2017). Are You Solving the Right Problems? *Harvard Business Review*, January–February 2017. <https://hbr.org/2017/01/are-you-solving-the-right-problems>
- Lafley, A. G., Martin, R. L., Rivkin, J. W., & Siggelkow, N. (2012). Bringing Science to the Art of Strategy. *Harvard Business Review*, September 2012. <https://hbr.org/2012/09/bringing-science-to-the-art-of-strategy>
- Klein, G. (2007). Performing a Project Premortem. *Harvard Business Review*, September 2007. <https://hbr.org/2007/09/performing-a-project-premortem>
- Kahneman, D., Rosenfield, A. M., Gandhi, L., & Blaser, T. (2016). Noise: How to Overcome the High, Hidden Cost of Inconsistent Decision Making. *Harvard Business Review*, October 2016. <https://hbr.org/2016/10/noise>
- Rumelt, R. P. (2011). The perils of bad strategy. *McKinsey Quarterly*, June 2011. <https://www.mckinsey.com/capabilities/strategy-and-corporate-finance/our-insights/the-perils-of-bad-strategy>
- Conn, C., & McLean, R. (2019). How to master the seven-step problem-solving process. McKinsey & Company. <https://www.mckinsey.com/capabilities/strategy-and-corporate-finance/our-insights/how-to-master-the-seven-step-problem-solving-process>
- Kepner-Tregoe. Using Situation Appraisal to Keep Track of Priority Situations（SUG の定義）. <https://kepner-tregoe.com/wp-content/uploads/2021/10/SA_Using-SA-to-Keep-Track-of-Priority-Situations.pdf>

### 書籍

- Minto, B. *The Minto Pyramid Principle*. <https://barbaraminto.com/>
- Rumelt, R. P. (2022). *The Crux: How Leaders Become Strategists*. PublicAffairs. <https://www.hachettebookgroup.com/titles/richard-p-rumelt/the-crux/9781541701243/>
- Conn, C., & McLean, R. (2019). *Bulletproof Problem Solving*. Wiley.
- Kepner, C. H., & Tregoe, B. B. *The New Rational Manager*. Kepner-Tregoe.
- Khalsa, M., & Illig, R. (1999). *Let's Get Real or Let's Not Play*.
