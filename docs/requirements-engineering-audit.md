# 要求工学監査: IPA『AI時代の要求管理ハンドブック』に照らした各ステップのデータ充足

監査日: 2026-11-19 (JST)。対象: 調査時点の作業ツリー（他の作業による未コミットの変更を含む）。第 1〜8 節は、実装の前の状態の監査結果である。改善案はその後に実装し、第 9 節にまとめた。付録 A の再現手順は実装の前の状態を再現するもので、実装後は別の結果になる（第 3 節の不足は解消している）。

基準: IPA『AI 時代の要求管理ハンドブック』Version 1.0.0（[PDF](https://www.ipa.go.jp/digital/kaihatsu/rqr7mi000000f5up-att/req-mgmt-hb.pdf)、129 ページ）。以下「HB」と書き、頁は本文の印刷頁を示す。本文は原本 PDF から抽出して読み、図は読んでいない。

## 1. 結論

**骨格は HB に沿っている。ただし、AI を使う解決策の要求定義書を作るための「入れ物」と「入手経路」が足りない。**

1. **非IT施策の区別は実装済み。** 解決策を `digital / process / people / asset / partner` の 5 種に分け、それぞれ専用の成果物を作る（[strategy.ts](../src/modules/project/strategy.ts#L21)）。HB 2.3（p.12）「要求の実現手段は、必ずしもシステムや AI に限らない」と、8.5（p.62）「最初から AI の利用を前提としない」を満たす。
2. **最大の欠落は、アプリ・プロンプト・AI エージェントの区別がないこと。** 3 つとも `digital → requirements` の 1 種類にまとめられている（[strategy.ts](../src/modules/project/strategy.ts#L25)）。要求定義書の節（[solutionDocs.ts](../src/modules/project/solutionDocs.ts#L16)）には、HB が AI に求める次の項目がない。
   - 表19・表20（p.35–37）: 不確実性と、AI が迷ったときの振る舞い
   - 表21（p.38–39）: プロンプトの要素
   - 表29・表30（p.59–60）: データ供給チェーン
   - 表54（p.107）: 「AI 要求管理」
3. **入手経路が、要求定義に必要な情報まで届いていない。** Work IQ を使うのはパック生成のときだけで、検索観点は組織・KPI・業務・データ・拠点・人・案件・課題に限られる（[workiq.ts](../server/workiq.ts#L133)）。次の情報を取りに行く経路はない。
   - 非機能要求
   - 法令・社内規程
   - 現行システムの運用条件
   - 問い合わせ・クレーム・監査指摘（HB 8.1、p.56）

   ステップ5の Copilot ドラフトには、上流の事実しか渡されない。そのうえ「会社の事実を作らない」と指示されている（[formDraft.ts](../src/modules/project/formDraft.ts#L71)）。このため、上の欠落は Copilot でも根拠付きでは埋まらない。
4. **すでに取得したデータが要求定義書に届いていない。** パックの `architecture.asIs`（現行システム）、`dataCatalog`、`glossary` は、要求定義書の生成（`solutionDocs.ts`）と工程ドラフト（`deliverableDraft.ts`）のどちらでも使われていない。配線するだけで、手入力を増やさずに改善できる。
5. **管理面に弱点がある。** いずれも第3節で実行して確かめた。
   - 要求 ID は位置番号で、識別子として安定しない。
   - 要求ごとの優先度・状態・版・変更理由がない。
   - 曖昧な要件文が完成判定を通る。

## 2. 依頼の意図と深掘り

意図は、要求工学の章立てを満たしているかという形式の点検ではないと解釈した。問いは次のとおり。

- 最終成果物（アプリ・プロンプト・AI エージェントの要求定義書、または非IT施策の計画）を作るのに必要なデータを、各ステップで手入力に頼らず根拠付きで埋められるか。
- 埋められないなら、ファイル・Work IQ・Web のどの経路で補うべきか。

1. **専門家が追加すること:**
   - 要求定義書の型を、解決策の種類ごとに分けて点検する。
   - HB の必須項目を項目単位で突き合わせ、各項目について入れ物・入手経路・検査の 3 点を判定する。
   - ID の安定性と、曖昧な要件文の扱いを確かめる。
2. **生の素材:** HB 原本と、BAS のソース（工程定義、節定義、スキーマ、Work IQ の観点、取込可能な形式、Copilot のプロンプト）。既存の監査文書は根拠にしない。
3. **手法:**
   - HB 表3 の 5 活動（REBOK）
   - ISO/IEC/IEEE 29148 の要件品質（HB p.14 脚注7）
   - BABOK の引き出し手法（HB 表4）
   - トレーサビリティマトリクス（HB 11.4）
   - データリネージ（HB 8.4）

   ツールは、ソース読解と、Vitest による生成関数の実行である。
4. **独立した確認:** 第三者が再実行できるテスト（第3節）。照合先は HB の表番号・頁と、ソースの行番号である。

### 実行した書き直しプロンプト

> BAS の最終成果物（アプリの要求定義書、プロンプト仕様、AI エージェントの要求、非IT施策の計画）について、5 ステップが HB の要求項目を満たせるかを監査する。対象項目は、表9（台帳）、表19・表20（不確実性）、表21（プロンプト）、表29・表30（データ供給チェーン）、表31（仕様観点）、表54（成果物）、7.2 の 12 工程である。
>
> 項目ごとに次の 3 点を判定する。
>
> 1. 入れ物（スキーマ・節・フィールド）があるか
> 2. ファイル取込／Work IQ／Web／Copilot 推論／人手のどれで、どの経路を通って埋まるか
> 3. 埋まったことをアプリが検査しているか
>
> 証拠は HB 原本の頁とソースの行番号に限る。生成関数をサンプルパックで実行し、次の 3 点を再実行できるテストで示す。
>
> - 上流を全部埋めても残る `[要記入]`
> - 要求 ID の安定性
> - 曖昧な要件文が検査を通るか
>
> 範囲を広げずに深くする。コードは直さず、手入力を最小にする方向で、優先度付きの提案を出す。

## 3. 実行による検証（第三者が再実行できる）

`samplePack` と demo の KPI・ユースケースを使い、実際の `buildSolutionDoc` と `evaluateStep` を Vitest で実行した。再現コードは付録 A にある。

| 確認 | 条件 | 結果 | 意味 |
|---|---|---|---|
| 上流をすべて埋めても残る `[要記入]` | 全工程の全フィールドを人が記入済みにした。全解決策に KPI 貢献があり、会社目標にも接続した | `digital`: **nonFunctionalReq**（常に残る）と functionalReq（解決策に登録済みユースケースがない場合）<br>`people`: policyChange, impact, changeApproach, governance<br>`asset`: procurement<br>`partner`: sourcingScope, selection, contract<br>`process`: なし | 非機能要求と非IT施策の主要な節には、BAS 内のどこにも入力元がない。人が節に直接書くしかない |
| 要求 ID の安定性 | BR-1 が指す KPI をプロジェクトから外す | 前: `BR-1: 受注〜出荷リードタイム を 16 から 10 日…`<br>後: `BR-1: 納期遵守率 を 88 から 95 %…` | ID が配列の位置番号になっている（[solutionDocs.ts](../src/modules/project/solutionDocs.ts#L149)）。HB 表9（p.17）の「一意の識別子」を満たさない。外部の議事録や課題票が「BR-1」を参照していると、指す要求が黙って変わる |
| 曖昧な要件文 | ソリューション工程の 6 フィールドすべてに「システムは使いやすいこと（2027年3月までに1回確認）」を入れる | `uc-doc` は `docComplete` で **合格** | 検査は数字と日付の有無だけを見る（[deliverables.ts](../src/modules/project/deliverables.ts#L227)）。HB p.14 が悪い例に挙げる「使いやすいこと」も、数字が 1 つあれば通る。29148 の Unambiguous・Verifiable・Singular は検査していない |

## 4. HB の 12 工程（7.1、p.53）と BAS

判定は次の 3 段階である。○ は実装経路があり、入手経路も実在する。△ は入れ物か経路の一方が欠ける、または人手に依存する。× は入れ物がない。

| HB 工程 | BAS の対応 | 主な入手経路 | 判定 |
|---|---|---|---|
| 1 目的・ミッション | 現状分析の problem・impact・sponsor、あるべき姿の vision、会社目標との接続（`tobe-link`） | 会社アンカーの取込、パック（中期計画・統合報告書）、人 | ○ |
| 2 ステークホルダー | person・persona、要求定義書の stakeholders（KPI オーナー・施策責任者・利用者）（[solutionDocs.ts](../src/modules/project/solutionDocs.ts#L144)） | Work IQ の org・people 観点 | △ HB 7.2.2 の AI の確認者・データ管理者・事故対応者、法務・セキュリティ・監査を置く場所がない |
| 3 要求獲得 | パック生成、議論の記録、判断レポートの取込（[reportRequirements.ts](../src/modules/project/reportRequirements.ts#L1)） | Work IQ の 10 観点と不足項目の追加検索、公式 URL、ニュース、テキスト資料、M365 Copilot の 2 段プロンプト | △ HB 8.1 の問い合わせ履歴・クレーム・障害報告・監査指摘・操作ログを取る観点がない。資料はテキスト形式だけで、合計 4 万字まで（[PackGenerateDialog.tsx](../src/modules/project/PackGenerateDialog.tsx#L530)、[packGenerate.ts](../src/modules/project/packGenerate.ts#L40)） |
| 4 要求分析 | 課題の順位付け、着手判断（pursue/notNow/no）、解決策 5 種、options、判断支援の 5 軸 | パック、人、Copilot | △ 代替手段の比較は良い。ただし HB 8.5 の「機能ごとの AI 利用要否」、HB 8.2 の「マスの意見と光る原石」の区別、要求間の矛盾・重複の検出がない |
| 5 要求仕様化 | 要求定義書 12 節（29148 系）、非IT施策の 4 種の計画 | 上流の自動転記、Copilot 節ドラフト（承認後に反映）、人 | △ 非機能要求は常に `[要記入]`（第3節）。AI・プロンプトの仕様、例外、ログ・証跡の節がない |
| 6 モデリング | ユースケースの手順、業務フロー（workflow 拡張）、戦略マップ、関係グラフ | パック、Work IQ の process 観点 | △ 状態遷移、データモデル、AI 利用モデルはない |
| 7 要求評価 | 手動の合意 ToDo（`define-agree`、`uc-review`、`sol-review`、`plan-approve`）と自動検査 | 人 | △ 品質検査が数字と日付の有無だけ（第3節） |
| 8 ベースライン化 | 工程の確定と引継ぎのスナップショット（ハッシュで上流の変更を検知） | 人 | △ 工程単位であり、要求単位の版はない |
| 9 実現手段への接続 | 施策（initiative）、ガント、要求定義書の Markdown | 人、パック | △ 開発バックログや ReqIF への出力がない |
| 10 運用・監視 | KPI の dataSource・frequency・owner、`kpi-measure` | 人、Work IQ の KPI 観点 | △ 業務 KPI の測定はある。AI の出力品質・ドリフト・再評価条件（HB 5.3・表19）はない |
| 11 フィードバック・変更管理 | 確定後の変更を「変更」「追加」「削除」で示し、下流に再確定を求める | 自動 | △ 変更理由・影響分析・承認者の記録（HB 表54「変更管理記録」）がない。節の手書き文は作成者も日時も持たない（[strategy.ts](../src/modules/project/strategy.ts#L63)） |
| 12 廃止・移行 | processPlan の transition、非機能要求の「移行」（`[要記入]`） | 人 | × デジタル解決策の移行・廃止の節がない |

## 5. 成果物の種類別: 入れ物と入手経路

### 5.1 アプリ（`digital` → 要求定義書）と HB 表31（p.64）

| 表31 の観点 | BAS の節 | 入手経路 | 判定 |
|---|---|---|---|
| 目的 | purpose（会社目標 → OKR → KPI の鎖） | 自動 | ○ |
| 対象 | scope、stakeholders | 現状分析の scopeIn・scopeOut、人 | ○ |
| 入力・処理・出力 | functionalReq（ユースケースの手順） | ユースケース（Copilot ドラフト → 承認） | △ 手順名だけで、入出力・データ項目・業務ルールがない（[store.ts](../src/modules/usecases/store.ts#L15)） |
| 制約 | constraints（予算、期間、現状分析の constraints） | 自動、人 | △ 取得済みの `architecture.asIs` を使っていない |
| 例外 | なし | — | × |
| 評価 | acceptance（KPI 目標） | 自動 | △ 業務の受入基準だけ。機能ごとの検証方法はない |
| 監視・変更 | なし（ステップ3 の測定は業務 KPI） | — | × |
| 証跡 | なし | — | × |
| 非機能 | nonFunctionalReq | **どこからも入らない** | × |
| データ | dataReq（製品名、ソリューション工程の dataNeeds） | 人 | △ 取得済みの `dataCatalog` を使っていない |

### 5.2 プロンプト（HB 5.4、表21、p.38–39）

成果物の種類がない。HB 表21 の 8 要素（目的・役割・入力・制約・出力形式・評価基準・確認事項・根拠）について、置く場所も入手経路もない。HB は「プロンプトも管理対象」とし、変更履歴・承認・評価結果を残すよう求めている（p.39）が、これも同じである。プロンプトだけで解決する案は、現状では要求定義書（アプリ用）として出力される。その結果、非機能要求などアプリ向けの `[要記入]` が残り、プロンプト固有の項目は欠ける。

### 5.3 AI エージェント（HB 5.3・5.6・8.4・8.5、表19・20・29・30・54）

成果物の種類がない。次の項目について、入れ物も経路もない。

- **人とエージェントの役割分担:** 自動か推奨か承認か、エスカレーションの条件（8.5 の 1）
- **不確実性:** 精度・確信度・ハルシネーション・OOD・フェイルセーフ（表19）。迷ったときの振る舞い（表20）
- **データ供給チェーン:** 出典・権利・代表性・保存と削除（表29）。データとモデルの対応（表30）

`dataCatalog` の項目は name・description・columns・domain・url だけである（[catalogSchema.ts](../src/modules/usecases/catalogSchema.ts#L9)）。所有者・出典・利用条件・個人情報・品質・更新頻度・保存期間を置けない。

### 5.4 非IT施策（process / people / asset / partner）

process は上流のデータだけで完成する。people・asset・partner には、上流を全部埋めても `[要記入]` が残る節がある（第3節）。

- **policyChange・governance（people）:** 現行の規程・承認手続きが入力になる。現行規程は Work IQ で取得できる性質のデータだが、規程を探す観点がない。
- **impact（people）:** 対象者の人数・職種。Work IQ の org 観点で一部は取れるが、配線されていない。
- **procurement・selection・contract:** 社内の調達規程や既存の契約が入力になる。これも探す観点がない。

## 6. 要求管理台帳（HB 表9、p.17）との対応

| 表9 の項目 | BAS | 判定 |
|---|---|---|
| 要求 ID | BR-n・FR-n・AC-n を表示のたびに位置で採番 | × 不安定（第3節） |
| 要求名・要求文 | 節の本文（1 節に複数の要求が入る） | △ 要求単位の行がない |
| 要求種別 | 節（業務・機能・非機能・データ）。判断レポートの取込では機能・非機能・業務を分類（[reportDrafts.ts](../src/modules/project/reportDrafts.ts#L351)） | △ AI・ルール・評価・運用の種別がない |
| 発生源 | エンティティの sourceIds。判断レポートは行番号まで引用 | △ 要求定義書の各行に発生源がない |
| 根拠 | 会社目標 → OKR → KPI の鎖 | ○ 業務要求に限る |
| 優先度 | 課題の順位はある | × 要求ごとの優先度（Must/Should/Could）はない |
| 状態 | 節の未記入・記入済み。工程フィールドの AI 記入・承認済み（[deliverables.ts](../src/modules/project/deliverables.ts#L36)） | △ 候補・承認・実装中・検証済の状態がない |
| 関連要求 | RTM（会社目標・OKR・KPI・ユースケース・施策・節） | △ 要求同士の依存関係がない |
| 検証方法 | 受入基準 = KPI 目標 | △ |
| 作成履歴・担当者・変更履歴・版 | 工程の確定（at・by）、フィールドの承認（at・by） | × 要求定義書の節の手書き文は文字列だけで、誰がいつ書いたかを持たない |

## 7. 入力経路の監査

| 経路 | 実際に取れるもの | 要求定義で取れないもの | 根拠 |
|---|---|---|---|
| ファイル | パック生成の資料（txt・md・csv・tsv・json・html、合計 4 万字）、パック zip、議論の md・json、カタログの json・csv、会社アンカーの json・md | Office・PDF の直接取込（M365 Copilot を経由する設計）。問い合わせログなど大量の記録は上限を超える | [PackGenerateDialog.tsx](../src/modules/project/PackGenerateDialog.tsx#L530)、[PackDataScreen.tsx](../src/modules/project/PackDataScreen.tsx#L408) |
| Work IQ | 組織・人・拠点・業務・データ資産・KPI（全社と事業部）・案件・課題、目的の論点ごとの検索、不足項目の追加検索。ステップ3 の社内 KPI の採用 | 規程・ガイドライン・セキュリティ基準・SLA・現行システムの運用手順・問い合わせ・監査指摘・AI 利用方針 | [workiq.ts](../server/workiq.ts#L133)、[analysisReadiness.ts](../src/modules/project/analysisReadiness.ts#L23)、[kpiAdopt.ts](../src/modules/project/kpiAdopt.ts#L10) |
| Web | 利用者が指定した公式 URL（同一サイト 6 ページまで）、ニュース、M365 Copilot の Web モードでの公開調査 | 法令・業界標準の原文（例: e-Gov 法令）を外部要件として取り込む経路 | [docs/decision-guide.md](decision-guide.md)、[copilot-customer-pack-prompt.md](copilot-customer-pack-prompt.md) |
| Copilot（BAS 内） | 工程ドラフト、ユースケース・KPI 貢献・節のドラフト（承認後に反映） | 新しい事実。入力は上流の事実だけで、「会社の事実を作らない」と指示される | [formDraft.ts](../src/modules/project/formDraft.ts#L50)、[deliverableDraft.ts](../src/modules/project/deliverableDraft.ts#L12) |
| 人 | すべての節・フィールド | — | — |

「Web IQ」という名前の機能は、BAS のソースにはない。本書では、上の Web 行の 3 経路を Web からの入手として扱った。

## 8. 改善提案（手入力を最小にする順）

**P1（追加入力ゼロ、または既存経路の延長）**

1. **取得済みデータを要求定義書に配線する。**
   - `architecture.asIs` を constraints と非機能要求の候補（連携先・移行対象）に入れる。
   - `dataCatalog` を dataReq に入れる。
   - `glossary` を新しい「用語定義」節に入れる。用語の定義は、HB p.14 の一意解釈の助けにもなる。
   - 検証: 第3節のテストで、この 3 つを持つパックから、要求定義書の該当節が埋まることを確かめる。
2. **`digital` を「アプリ／プロンプト／AI エージェント」の 3 つに分け、それぞれの節を持たせる。**
   - **プロンプト:** HB 表21 の 8 要素、参照データ、レビュー手順、版と評価結果。
   - **エージェント:** 上の項目に加えて、HB 8.5 の 4 点（役割分担・データ・評価・監視）、表19・表20 の振る舞い、表54「AI 要求管理」。
   - 埋め方: 多くは Copilot が表20 の定型（低確信度は人へ回す等）から節ドラフトを作り、人が承認する。評価データは利用者のファイル（CSV）から取る。
3. **要求 ID を固定し、要求単位の台帳属性を持たせる。**
   - ID は、KPI・ユースケースの ID から導くか、初回の採番を保存する。
   - 属性: 優先度・状態・発生源・検証方法、節の作成者と日時。
   - 検証: 第3節の ID テストが逆の結果になること（KPI を外しても、他の要求の ID が変わらない）。

**P2（入手経路の追加）**

4. **Work IQ に要求定義用の観点を足す。** 3 つとも、既存の観点と同じく readiness で不足を検査し、追加検索する。
   - `rules`: 規程・ガイドライン・セキュリティ基準・SLA・AI 利用方針
   - `systems`: 現行システムと運用手順
   - `voice`: 問い合わせ・クレーム・障害・監査指摘（HB 8.1）
   - これで非機能要求・規程・ガバナンス・調達の `[要記入]` に、根拠付きの候補が入る。
5. **ステップ5 の節ドラフトに、節ごとの Work IQ 検索を添えられるようにする。** 現在は上流の事実だけを使う。検索結果は出典付きの候補として扱い、人が承認したときだけ反映する。
6. **M365 Copilot の 2 段プロンプトの収集項目に、上の 3 観点を加える。** Office・PDF の規程や仕様書は、この経路で取り込める。8,000 字の上限に注意する（tests/pack-import.test.ts）。

**P3（検査と管理）**

7. **要件文の品質検査を 29148 に近づける。** 曖昧語（使いやすい・迅速・適切・柔軟 等）の検出、1 文 1 要求、数値と単位と条件のそろいを見る。
8. **`dataCatalog` に表29 の属性を任意項目として足す。** 所有者・出典・利用条件・個人情報・品質・更新頻度・保存期間。
9. **課題に「頻度」と「重大度」を分けて持たせ、少数でも重大な課題を示す。** HB 8.2 の光る原石にあたる。
10. **変更管理記録（理由・影響・承認者）と、CSV または ReqIF への出力を加える。**

## 9. 実装状況（2026-11-19、改善案 1〜10 をすべて実装）

| 案 | 実装 | 確認 |
|---|---|---|
| 1 取得済みデータの配線 | 現行システム（`architecture.asIs`）を非機能要求（移行・連携）とデータ要求（連携先）へ、用語集を「用語の定義」へ、データ辞書を解決策が名前を挙げたデータ（辞書が 8 件以下なら全件）のデータ要求へ入れる。このプロジェクトで取り込んだ辞書がPackのものより優先 | `tests/requirements-engineering.test.ts` |
| 2 アプリ／プロンプト／AI エージェント | 解決策の種類に `prompt`・`agent` を追加。プロンプト仕様書（表 21 の要素ほか）と AI エージェント要求定義書（役割分担・表 19 の不確実性・表 20 の迷ったときの振る舞い・表 29 のデータ供給チェーン・評価・監視・記録）。節ごとの Copilot ドラフトにハンドブックの確認項目を渡す | 同上、`e2e/project-requirements.spec.ts` |
| 3 安定した要求 ID と台帳 | `BR-<KPI>`・`AC-<KPI>`・`FR-<ユースケース>`・`VC-`・`NFR-`・`CN-`・`DR-`・`IF-`。優先度・状態・検証方法・更新者。節の作成者と日時 | 同上、`tests/requirements-panels.test.tsx` |
| 4 Work IQ の観点 | `rules`（規程・基準・SLA・AI 方針）、`systems`（現行システム・運用手順）、`voice`（問い合わせ・クレーム・障害・監査指摘）。パック生成には含めず、要求の根拠パネルから押したときだけ検索し、採用したものだけを根拠にする | 同上 |
| 5 節ごとの Work IQ 検索 | 非機能要求・制約・機能要求・データ要求などの節に「Work IQ で根拠を探す」。見つかった内容は下書きの根拠として渡し、承認するまで文章に入れない。「根拠として保存」で保存できる | `tests/requirements-panels.test.tsx` |
| 6 M365 Copilot プロンプト | 収集対象に規程・SLA・AI 方針・問い合わせ・監査記録を追加し、`extensions.requirementEvidence`（出典必須）とデータ辞書の属性を出力させる。8,000 字の上限のため、既存の説明を短縮した | `tests/pack-import.test.ts` |
| 7 要件文の品質検査 | 確かめられない表現（使いやすい・迅速・適切・easy・fast など）は数値と条件がない限り指摘し、複数の要求を 1 文に書くと指摘する。受入条件・成功の定義の欄は指摘が残る間は完了しない | 同上 |
| 8 データ辞書の属性 | 所有者・出所・利用条件・個人情報・品質・更新頻度・保存期間（JSON・CSV。CSV の見出しは大文字小文字を区別しない） | 同上 |
| 9 光る原石 | 課題ごとに頻度と重大度を記録し、まれで重大な課題を示す。順位は変えない。利用者の声の根拠に課題を結び付けられる | 同上、`e2e/project-requirements.spec.ts` |
| 10 変更管理記録と書き出し | 変更管理記録（対象・内容・理由・影響・承認者）。要求の一覧は CSV と ReqIF 1.2、変更管理記録は CSV | 同上 |

実装で補ったこと:

- AI の評価データは、ファイルの抜粋・件数・列・ラベルの分布だけを保存し、各行は保存しない。
- 台帳は、プロンプト・エージェントを含むすべてのシステム系の成果物に出る（AI の節は 1 節 1 要求 `AI-<節>` として並ぶ）。
- 「Web IQ」という機能はソースにないため、実装していない。

## 10. 限界

- 実行による確認は、サンプルパックでの単体実行と、Work IQ を模した応答での画面の確認だけである。実テナントの Work IQ・M365 Copilot・Web は実行していない。経路が実在することは確かめたが、取得の質は確かめていない。\n- ReqIF は整形式の XML であることまで確かめた。外部の要求管理ツールへの取り込みは試していない。\n- 確かめられない表現の語彙は経験則の一覧で、見落としと過検出がありうる。指摘は人が判断する（書き換えはしない）。
- HB はリビングドキュメントで、「すべての成果物を必ず作る必要はない」としている（p.106）。小規模なら目的・要求一覧・台帳・要件定義書・受入条件でよく、AI を使うなら AI 要求管理とデータ定義を加える（p.108）。本書の「×」は、BAS の最終成果物に AI ソリューションが含まれる以上、少なくともこの最小構成が必要だという前提での判定である。
- 判定は作業ツリーの時点のものである。未コミットの他の変更が確定すると変わることがある。

## 付録 A: 再現手順

次の内容を `tests/zz-req-audit-probe.test.ts` として保存し、`npx vitest run tests/zz-req-audit-probe.test.ts --reporter=verbose` を実行する（`console.log` は verbose のときだけ表示される）。確認後、ファイルは削除する。2026-11-19 の作業ツリーで実行し、第3節と同じ結果が出ることを確かめた。

```ts
import { it } from 'vitest';
import { samplePack } from '../src/data/sample.ts';
import { loadPack } from '../src/data/pack.ts';
import { demoKpis } from '../src/modules/project/kpiOkr.ts';
import { emptyStrategy, setSolutionType, strategyThread, upsertContribution, type SolutionType } from '../src/modules/project/strategy.ts';
import { buildSolutionDoc } from '../src/modules/project/solutionDocs.ts';
import { emptyDeliverables, evaluateStep, setField, STEP_DEFS } from '../src/modules/project/deliverables.ts';
import { demoUseCases } from '../src/modules/usecases/seed.ts';
import type { ImprovementStep } from '../src/state/projects.ts';

const pack = loadPack(samplePack);
const kpi = demoKpis(pack.pack);
const sols = pack.pack.entities.filter((e) => e.kind === 'solution');
const contrib = (sid: string, kid: string) => ({ id: `c-${sid}-${kid}`, solutionId: sid, kpiId: kid, lever: 'l', leverUnit: 'u',
  amount: { low: 1, mode: 2, high: 3 }, effectPerUnit: { low: 0.1, mode: 0.2, high: 0.3 },
  rampStart: '2026-12-01', fullEffect: '2027-01-31', basis: 'measured' as const, evidence: 'pilot' });
let full = emptyDeliverables();
for (const st of Object.keys(STEP_DEFS) as ImprovementStep[]) for (const f of STEP_DEFS[st].fields)
  full = setField(full, st, f.id, { text: `${f.id}: 12 件、2027年3月`, author: 'human', updatedAt: '2026-11-19T00:00:00Z' });

it('open sections with full upstream', () => {
  for (const type of ['digital', 'process', 'people', 'asset', 'partner'] as SolutionType[]) {
    let s = emptyStrategy();
    for (const x of sols) { s = setSolutionType(s, x.id, type, 'A', '2026-11-19T00:00:00Z'); for (const k of kpi.kpis.slice(0, 2)) s = upsertContribution(s, contrib(x.id, k.id)); }
    const c = { pack, kpi, useCases: demoUseCases(), strategy: s, objectives: [{ id: 'o1', text: 'O' }], projectObjectiveIds: ['o1'], deliverables: full, today: '2026-11-19' };
    const t = strategyThread(c);
    console.log(type, [...new Set(sols.flatMap((x) => buildSolutionDoc(x, t.solutions.find((y) => y.id === x.id)!, t, c, 'ja').sections.filter((z) => z.open).map((z) => z.id)))]);
  }
});

it('BR ids are positions', () => {
  const x = sols[0]!;
  let s = setSolutionType(emptyStrategy(), x.id, 'digital', 'A', '2026-11-19T00:00:00Z');
  for (const k of kpi.kpis.slice(0, 2)) s = upsertContribution(s, contrib(x.id, k.id));
  const br1 = (kpis: typeof kpi.kpis) => {
    const c = { pack, kpi: { ...kpi, kpis }, useCases: demoUseCases(), strategy: s, objectives: [], projectObjectiveIds: [], deliverables: emptyDeliverables(), today: '2026-11-19' };
    const t = strategyThread(c);
    return buildSolutionDoc(x, t.solutions.find((y) => y.id === x.id)!, t, c, 'ja').sections.find((z) => z.id === 'businessReq')!.text.split('\n')[0]!;
  };
  const a = br1(kpi.kpis);
  const first = kpi.kpis.find((k) => a.includes(typeof k.name === 'string' ? k.name : k.name.ja))!;
  console.log(a, '→', br1(kpi.kpis.filter((k) => k.id !== first.id)));
});

it('vague text passes', () => {
  let d = emptyDeliverables();
  for (const f of STEP_DEFS.solution.fields) d = setField(d, 'solution', f.id, { text: 'システムは使いやすいこと（2027年3月までに1回確認）', author: 'human', updatedAt: '2026-11-19T00:00:00Z' });
  const c = { pack, discussion: { themes: [], records: [] }, kpi, analysis: { analyses: [] }, useCases: demoUseCases(), deliverables: d, today: '2026-11-19' } as unknown as Parameters<typeof evaluateStep>[1];
  console.log(evaluateStep('solution', c).find((r) => r.todo.id === 'uc-doc')?.outcome);
});
```
