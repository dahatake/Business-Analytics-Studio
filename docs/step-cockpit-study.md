# 各ステップの判断ビューと What-if の設計（FR-378）

2026-11-26。対象: 上部のステップ（1 現状分析 〜 5 要求定義・計画）を押したときに開く画面（`/step?step=<段>`）。要求は [FR-378](requirements-definition.md)、判断は [D-52](decision-guide.md)。

## 1. 画面に出すもの

各ステップの画面は、そのステップで下す判断を 1 つの問いにし、その問いに答えるのに必要な最小限だけを既定の「判断」ビューに出す。これまでの分析（戦略マップ・根拠の内訳・遅延コスト・助言・完了条件のタイル・成果物の状態など）は「詳細分析」タブに移し、消さない。詳細のパネルへの直接のリンク（`target`）は詳細分析を開く。

| ステップ | 決めること（問い） | エグゼクティブサマリーの数値（カード） | 判断に使う最小限のデータ（図 1 つ） | What-if |
|---|---|---|---|---|
| 1 現状分析 | どの課題から取り組むか | 取り組む課題・影響度×実現性の 1 位・出典のある課題の割合・完了条件 | 影響度×実現性の 4 象限 | 課題の優先順位（7 基準・制約・感度・確かさ・予算と効果・シナリオ比較） |
| 2 あるべき姿 | どの差を埋めれば上位の課題が解決した状態になるか | 上位 3 課題のあるべき姿・ユースケース・提案中の KPI/OKR・完了条件 | KPI の目標までの残りの差 | 同上（課題） |
| 3 KPI/OKR 定義 | この目標と期限で、続けるか止めるかを判定できるか | KPI の数・定義が妥当な割合・OKR に結び付く割合・完了条件 | KPI の定義の品質 | 目標・期限・効果・着手の遅れ → 毎月必要な進みと到達確率 |
| 4 ソリューション作成 | どの解決策に投資するか | 解決策・年間の効果・費用・完了条件 | 期限の KPI の幅（P10〜P90）か投資回収の年数 | 解決策の優先順位と予算内の組み合わせ |
| 5 要求定義・計画 | 選んだ解決策をどの対応策でいつまでに実行するか | 解決策・計画に入れた解決策・保存した要求定義書・完了条件 | 解決策ごとの対応策の種類（推定の理由つき） | 解決策の選定 → アクションプラン → 要求定義書 |

エグゼクティブサマリーは既存の規則の要約（FR-318、事実の台帳から作る）を使い、結論・裏付け 3 点・次の一手だけを出す。生成 AI の文章ではないことを常に表示する。

## 2. 優先順位の評価基準の選定

### 2.1 一次資料の比較

| 枠組み | 基準 | 組み合わせ方 | 必要なデータ | 長所 | 短所 |
|---|---|---|---|---|---|
| Nieto-Rodriguez（HBR 2016） | 戦略との整合、目的の階層 | 定性 | 目的・ビジョン・優先事項 | 絞り込み・中止の判断 | 数値の式がない |
| DICE（Sirkin ほか、HBR 2005） | 期間・チームの能力・経営と現場の関与・追加の負荷 | D + 2I + 2C1 + C2 + E（7〜28） | 実行の評価 | 実行の難しさを実証的に見る | 価値を見ない |
| R-W-W（Day、HBR 2007） | 本物か・勝てるか・やる価値があるか | 定性の 6 問 | 市場と競争の事実 | リスクとリターンの均衡 | 順位を出さない |
| リアルオプション（Luehrman、HBR 1998） | 価値と費用の比・不確かさ | NPVq と変動性 | キャッシュフローの見積もり | 不確かさと時期を扱う | 見積もりが難しい |
| WSJF（SAFe）・CD3（Reinertsen 2009） | 価値・時間的な切迫度・リスク低減と機会 ÷ 規模 | 遅延コスト ÷ 期間 | 相対評価、または金額と期間 | 着手順を経済性で決める | 相対評価はばらつく |
| RICE（McBride、Intercom 2018） | 到達・効果・確信度 ÷ 工数 | R × I × C ÷ E | 到達の件数 | 確信度で便益を割り引く | 製品開発向け |
| 採点モデル（Cooper ほか 1999・2001） | 戦略との整合・優位性・市場の魅力・既存の強みの活用・実現性 | 重み付き和 | 判断 | 実証で成績がよい | 拒否条件を隠し得る |
| 多属性価値理論（Keeney 1992、Edwards & Barron 1994） | 目的から導いた属性・スウィング重み | Σ w·v | 重みの引き出し | 理論的に正しい | 引き出しの規律が要る |
| ポートフォリオ決定分析（Salo ほか 2011） | 価値・費用・予算 | 予算の制約下で Σ v を最大化（0/1 ナップサック） | NPV と費用 | 予算内で最適 | 妥当な入力が要る |
| アイゼンハワー・MoSCoW | 緊急度と重要度・必須度 | 2×2・序列 | 判断 | 簡単 | 工数・不確かさ・予算を扱わない |

### 2.2 選んだ基準（相互に重ならない 7 つ）

便益（何が得られるか）・時間（いつまでに）・確かさ（どれだけ信じられるか）・実行（できるか）・選択肢（戻せるか）を、規模（どれだけかかるか）と分ける。予算と着手できる件数は点数に混ぜず、制約として扱う（Salo ほか）。

| 基準 | 定義 | 主な出典 | 既定値の出どころ（値は作らない） |
|---|---|---|---|
| 価値・インパクト | 実現したときの効果の大きさ | Cooper ほか、RICE | 課題: 影響度（データ）。解決策: 年間効果の順位、なければ対応する課題の影響度の最大 |
| 戦略との整合 | Project の KPI・OKR にどれだけ直接つながるか | Kaplan & Norton（HBR 2008）、Nieto-Rodriguez | OKR の主要な結果の KPI → 5、Project の KPI → 4、パックの KPI だけ → 3、KPI なし → 1 |
| 確信度 | 根拠の強さ | RICE、Kahneman ほか「Noise」（HBR 2016） | 出典と測定値 → 5、どちらか → 3、なし → 1（PARAM-192 と同じ段階）。解決策は効果の見積もりの根拠（測定 5・ベンチマーク 4・専門家 3・仮定 2） |
| 実行のしやすさ | スポンサー・体制・現場の負荷から見た難しさの逆 | DICE | 課題: 実現性（データ）。解決策: 対応する課題の実現性の平均 |
| 可逆性・選択肢の価値 | 小さく試せて戻せるか、次の選択肢を開くか | Luehrman、Bezos（2015 年の株主への手紙の「二方向の扉」） | 試行の施策がある → 4、プロンプトの解決策 → 5、それ以外は未評価の 3 |
| 時間的な切迫度 | 期限の近さ・待つと失うもの | Reinertsen、SAFe WSJF | 最も近い KPI の期限まで 3 か月以内 → 5、6 → 4、12 → 3、24 → 2、それ以上 → 1（PARAM-212）。期限がなければ未評価 |
| 規模 | 相対的な大きさ（割る数） | WSJF の job size、RICE の effort | 登録された費用の順位、なければ施策の期間。どちらもなければ未評価 |

各基準の 1〜5 には言葉の目安（アンカー）を付けた（画面の選択肢）。評価者ごとのばらつき（ノイズ）を減らすには、同じ目安で独立に評価してから話し合うのがよい（Kahneman ほか 2016）。

### 2.3 組み合わせ方

```
便益   B = Σ wᵢ·(sᵢ − 1)/4 / Σ wᵢ            （価値・整合・確信度・実行・可逆性。0〜1）
時間   T = 1 + (u/100)·(s_切迫度 − 1)/4       （u = 切迫度の強さ 0〜100。最大 2 倍）
規模   S = s_規模 / 3                         （中立の 3 → 1）
優先度 P = 100 · B · T / S                    （WSJF の形: 価値 × 時間 ÷ 規模）
```

- 時間的な切迫度は足し算ではなく掛け算にした。足し算にすると、価値のない急ぎの項目が上位に来る（遅延コストは価値に比例して失われる）。
- 規模で割るのは、同じ価値なら小さく早く終わるものを先に進める方が待ちの損失の合計が小さくなるため（Smith 1956 の WSPT、Reinertsen の CD3）。
- 重みはスウィング重み（各基準を最悪から最良へ動かすことの価値）として決める。「重要度」の重みは誤りとされる（Edwards & Barron 1994）。既定の重み（PARAM-211）は、5 つの基準を価値・整合・確信度・実行・可逆性の順に並べた順位重心法の重み（0.46・0.26・0.16・0.09・0.04）を、どの基準も無視しないよう平らにして丸めた 30・25・20・15・10。切迫度の強さは 50。
- 出発点として 4 つの配分を用意した: バランス（既定）、価値を重視、確実性を重視、速さを重視。

### 2.4 予算と着手できる件数

予算（百万円）と同時に着手できる件数を入れると、便益 B·T の合計が最大になる組み合わせを動的計画法で求める（0/1 ナップサック）。予算を 400 単位（PARAM-213）に分け、費用は切り上げるので、選んだ組み合わせが予算を超えることはない。必ず実施する項目は先に確保し、それだけで予算か件数を超えれば警告する。費用が未登録の項目は予算と照合できないので、件数の枠だけで競わせ、その件数を表示する。予算ごとの最大値（効率的フロンティア）を 11 点で示す。

### 2.5 結果の示し方

- 基準（データから作った既定）との差: 順位の上下（▲▼と文字）、基準の優先度を点線で示し、色だけに頼らない。
- 感度: 重みを 1 つずつ ×0〜×3 で動かし（0.05 刻み、PARAM-214）、今の 1 位が保たれる範囲と、外れたときに 1 位になる項目を示す。範囲が狭い基準ほど、関係者の合意が要る。
- 1 位の確かさ: 重み（±50%、PARAM-193）と評価（根拠に応じ ±0.5〜1.5、PARAM-192）を同時に揺らした 1,000 回の試行（固定の種）で、1 位・上位 3 位の確率を示す。70% 以上（PARAM-194）で「確か」。
- シナリオ: 3 件まで（PARAM-216）保存し、基準・今のシナリオと並べて 1 位・選ばれた項目・便益・費用・重みを比べる。シナリオは Project のデータとして保存され、Project のデータ（課題や解決策）は変えない。
- 影響度×実現性だけの 1 位（アプリの既存の順位）と、規模と切迫度を入れた 1 位が違うときは、その旨と理由を表示する。サンプルでは影響度×実現性の 1 位は「受注から出荷までが長い」、WSJF の 1 位は「請求・入金の遅れ」で、遅延コストの分析（[prioritization-method-study.md](prioritization-method-study.md) §8.5）と同じ結論になる。

### 2.6 KPI のステップ

KPI の目標と期限を決めるときに知るべきなのは、必要な改善の速さが現実的かどうかである。単位の違う KPI を比べられるよう、「期限までに毎月、基準値から目標までの距離の何%を進める必要があるか」を示す（必要な速さ = 残りの差 ÷ 残りの月数 ÷ 距離）。目標（距離の ±50%）と期限（−6〜+12 か月）を動かせる。解決策の効果の見積もり（FR-314）があれば、効果の倍率と着手の遅れも動かし、モンテカルロ（2,000 回）で期限までに目標に届く確率を示す。

## 3. 最後のステップ: 対応策の種類、アクションプラン、要求定義書

### 3.1 対応策の種類

解決策は 1 つの種類では終わらない。解決策の種類（FR-312）・製品・説明の言葉から、必要な対応策の種類を推定し、理由（一致した製品名や言葉）を示す。利用者は種類を追加・削除できる。

| 種類 | 開発 | 推定の手掛かり（例） |
|---|---|---|
| Microsoft 365 Copilot・Cowork・Autopilot 用のプロンプト | ○ | Microsoft 365 Copilot、Copilot Chat、Cowork、Autopilot、プロンプト |
| エージェントのループを持つ AI エージェント | ○ | Copilot Studio、Microsoft Foundry、Agent Service、エージェント |
| UI・API・データベースを備えたアプリケーション | ○ | Power Apps、App Service、Dynamics 365、アプリ、画面（デジタルの解決策で他に手掛かりがないときの既定） |
| データ連携（ETL/ELT・連携フロー） | ○ | Microsoft Fabric、Data Factory、IoT、Power Automate、AI Search、連携、統合 |
| データの可視化 | ○ | Power BI、Digital Twins、可視化、ダッシュボード |
| 機械学習モデル | ○ | Azure Machine Learning、AI Vision、予測、異常検知、最適化 |
| 業務プロセスの変更・組織と人材・設備投資・外部の調達 | — | 解決策の種類（process・people・asset・partner） |

ソフトウェアの対応策には、稼働後の定着化（組織・人材）を必ず加える（Kotter, HBR 1995）。

### 3.2 アクションプラン

What-if で選ばれた解決策（または表で選んだ解決策）を、優先度の高い順に、同時に着手できる件数の並行の枠に割り当てる（リスト スケジューリング）。解決策の中は技術的な依存関係で並べる: データ連携 → 可視化・機械学習・エージェント・プロンプト、機械学習 → アプリ・エージェント、すべての構築 → 定着化。期間の既定値は種類ごとの目安（PARAM-215: プロンプト 2 週、エージェント 10、アプリ 16、データ連携 8、可視化 6、機械学習 12、業務 6、定着化 8、投資 12、調達 10）で、利用者が書き換えられる。

### 3.3 本番開発の要求定義書

開発の対応策がある解決策ごとに、`{解決策名}-Production-Requirements-Definision.md` を作り、データの保存先フォルダー（FR-339）の `projects/<企業名>-<Project名>/` に保存する（ファイル名の綴りは依頼のとおり）。構成は ISO/IEC/IEEE 29148:2018 に沿い（目的・範囲・利害関係者・業務要求・対応策ごとの要求・非機能・受入基準・優先度の根拠・実行計画・前提とリスク・追跡表・未決事項）、対応策の種類ごとに専門家が本番前に確かめる観点を持つ。

| 種類 | 観点 |
|---|---|
| プロンプト | 目的と利用者、入力データの出どころ、プロンプトの 4 要素（目標・文脈・期待する出力・情報源）、出力の形式と保存先、実行のしかた（手動・Cowork・Autopilot）、人の確認、評価、権限と秘密度ラベル |
| AI エージェント | 目標と完了の条件、自律度、ツールと権限、ループの上限（反復・時間・費用・停止条件）、知識と記憶、人の承認点と禁止操作、失敗時の扱い、評価（タスクの成功率・ツール呼び出し・根拠への忠実さ）、監視とログ、責任ある AI |
| アプリケーション | 利用者と役割、ユースケースと画面、API、データモデル、権限、非機能、監査ログ・運用・移行 |
| データ連携 | ソース、ターゲット、方式（ETL/ELT・バッチ/ストリーム）、鮮度の約束、データ契約、品質のルール、変換のルール、冪等性と再実行、系譜と監視、個人情報・ライセンス |
| 可視化 | 支える意思決定と利用者、指標の定義、切り口と粒度、データモデル、更新の頻度、行レベルのセキュリティ、画面の構成、アクセシビリティ |
| 機械学習 | 問題の定式化、予測する対象と時点、ベースライン、評価指標と合格の基準、学習データ、分割とリークの防止、説明可能性、再学習とドリフトの監視、推論の方式、責任ある AI |

値は Project のデータ（課題・原因・出典・KPI・OKR・ユースケース・施策・現行のシステム・データカタログ・効果の見積もり）からだけ入れ、根拠がない項目は【要記入】として残して末尾の未決事項に並べる。数値・日付・責任者は推定しない。同じ名前のファイルがあるときは上書きの前に確認する（フォルダーで直接編集した内容を守るため）。サーバーは名前を 1 つのパスの部品として検査し（`..`・区切り文字・予約名・`.md` 以外を拒否）、一時ファイルに書いてから置き換える。

## 4. 画面の構成とスタイル

経営者・意思決定者が使うアプリの共通の配置（Power BI のダッシュボード設計、Workday Adaptive Planning・Anaplan・Pigment のシナリオ、Tableau Pulse の指標カード、Viva Goals の進捗の状態）に合わせた。

1. 見出し: ステップの名前・目的、成果物を開く操作。下に「判断」と「詳細分析」のタブ。
2. エグゼクティブサマリー: 「このステップで決めること」の問い、結論、裏付け 3 点、次の一手。右に数値のカード 4 枚（Power BI の「最も重要な数値を上に大きく」）。
3. 判断に使う最小限のデータ: 結論を見出しにした図 1 つと同じデータの表（Berinato, HBR 2016）。
4. What-if（最も重要）: 枠の上端を強調し、左 4 列に条件、右 8 列に結果。結果は条件を動かしている間も見えるよう固定表示にし、見出しの文を `aria-live` で読み上げる。
5. 最後のステップ: 解決策と対応策の種類の表 → What-if → アクションプランと要求定義書。

Microsoft Design と Fluent 2 から適用したこと:

- Fluent 2 の設計原則「Built for focus」（雑音を減らし落ち着いて判断できる）: 既定のビューを判断に必要なものだけにし、詳細は別のタブに置いた。
- Fluent 2 のレイアウト: 4px を基本単位とするスペーシングのトークンだけを使い、線ではなく余白でまとまりを示す。最も重要な要素（What-if）に最も大きな領域を与える。1023px 以下は 1 列にする。
- Fluent 2 の色: 中立の面の上に、ブランドの色は主な操作と選択状態・選ばれた項目にだけ使う。意味の色は記号と文字（▲▼・「変更」・「選定」）と組み合わせ、強制カラーモードでも区別できる。
- Microsoft Design「UX design for agents」（2025）と HAX ガイドライン（Amershi ほか 2019）: 推奨の確からしさと理由を見えるようにして過信を防ぐ（1 位の確率・感度・評価の出どころの表示）、利用者が制御できる（基準に戻す・シナリオの保存と削除）、規則で作った数値と生成 AI の文章を区別して表示する。

## 5. 検証

| 確かめること | 方法 |
|---|---|
| 式（中立の項目の優先度 62.5、規模 2 倍で半分、切迫度の強さ 100 で 2 倍） | `tests/project-step-cockpit.test.ts` |
| 予算と件数の下の組み合わせが総当たりの最適と一致し、予算を超えない（40 組の乱数） | 同上 |
| 感度の境目が閉じた式と一致する（価値の重み ×0.7、整合の重み ×1.5） | 同上 |
| 1 位の確率の再現性と合計（1 位 = 1、上位 3 位 = 3） | 同上 |
| 既定値の出どころ（データ・規則・未評価）、対応策の種類の推定と理由、依存関係と並行の枠による計画 | 同上 |
| 要求定義書の構成・ID・【要記入】・英語版に日本語がない、保存の検査（パスの拒否・上書きの確認） | 同上 |
| 5 ステップの判断ビュー（問い・カード 4 枚・What-if、詳細のパネルが出ない）と axe、英語に日本語がない、シナリオの保存・比較・再読み込み後の保持・基準に戻す、予算と効率的フロンティア、KPI の What-if、対応策の編集・計画・要求定義書の保存と上書きの確認 | `e2e/project-step-cockpit.spec.ts` |

## 6. 限界

- 既定の重み（PARAM-211）・切迫度の月数（PARAM-212）・期間の目安（PARAM-215）は暫定値で、関係者が合意した重み、実績の期間で置き換える。
- 基準は互いに独立と仮定し、加重和で合わせる。拒否条件（規制違反など）は点数ではなく「必ず実施する」「除外する」で扱う。
- 規模で割るため、費用の小さい項目が上がりやすい。規模の評価が不確かなときは「規模」を未評価のままにする（中立の 3）か、感度で確かめる。
- 対応策の種類の推定は言葉と製品名による。推定は理由とともに示し、人が確かめて直す前提である。
- 要求定義書は Project のデータにあることしか書かない。【要記入】の項目は、開発の前に関係者が記入して合意する必要がある。

## 出典

- Nieto-Rodriguez, A. (2016). How to Prioritize Your Company's Projects. *Harvard Business Review*. <https://hbr.org/2016/12/how-to-prioritize-your-companys-projects>
- Sirkin, H. L., Keenan, P., & Jackson, A. (2005). The Hard Side of Change Management. *Harvard Business Review*, 83(10). <https://hbr.org/2005/10/the-hard-side-of-change-management>
- Day, G. S. (2007). Is It Real? Can We Win? Is It Worth Doing? *Harvard Business Review*. <https://hbr.org/2007/12/is-it-real-can-we-win-is-it-worth-doing-managing-risk-and-reward-in-an-innovation-portfolio>
- Luehrman, T. A. (1998). Strategy as a Portfolio of Real Options. *Harvard Business Review*. <https://hbsp.harvard.edu/product/98506-PDF-ENG>
- Kahneman, D., Rosenfield, A. M., Gandhi, L., & Blaser, T. (2016). Noise. *Harvard Business Review*. <https://hbr.org/2016/10/noise>
- Kahneman, D., Lovallo, D., & Sibony, O. (2011). Before You Make That Big Decision…. *Harvard Business Review*. <https://hbr.org/2011/06/the-big-idea-before-you-make-that-big-decision>
- Kaplan, R. S., & Norton, D. P. (2008). Mastering the Management System. *Harvard Business Review*. <https://hbsp.harvard.edu/product/R0801D-PDF-ENG>
- Kotter, J. P. (1995). Leading Change: Why Transformation Efforts Fail. *Harvard Business Review*. <https://hbr.org/1995/05/leading-change-why-transformation-efforts-fail-2>
- Berinato, S. (2016). Visualizations That Really Work. *Harvard Business Review*. <https://hbr.org/2016/06/visualizations-that-really-work>
- Scaled Agile. Weighted Shortest Job First. <https://framework.scaledagile.com/wsjf>
- Reinertsen, D. G. (2009). *The Principles of Product Development Flow*. Celeritas.
- McBride, S. (2018). RICE: Simple prioritization for product managers. Intercom. <https://www.intercom.com/blog/rice-simple-prioritization-for-product-managers>
- Cooper, R. G., Edgett, S. J., & Kleinschmidt, E. J. (1999). New Product Portfolio Management: Practices and Performance. *Journal of Product Innovation Management*, 16(4). <https://doi.org/10.1016/S0737-6782(99)00005-3>
- Keeney, R. L. (1992). *Value-Focused Thinking*. Harvard University Press.
- Edwards, W., & Barron, F. H. (1994). SMARTS and SMARTER. *Organizational Behavior and Human Decision Processes*, 60(3). <https://doi.org/10.1006/obhd.1994.1087>
- Salo, A., Keisler, J., & Morton, A. (Eds.). (2011). *Portfolio Decision Analysis*. Springer. <https://doi.org/10.1007/978-1-4419-9943-6>
- Smith, W. E. (1956). Various optimizers for single-stage production. *Naval Research Logistics Quarterly*, 3(1-2). <https://doi.org/10.1002/nav.3800030106>
- Amazon (2016). 2015 Letter to Shareholders（一方向・二方向の扉）。
- ISO/IEC/IEEE 29148:2018. <https://www.iso.org/standard/72089.html>
- Microsoft Design (2025). UX design for agents. <https://microsoft.design/articles/ux-design-for-agents/>
- Fluent 2 Design System. Design principles / Layout / Color. <https://fluent2.microsoft.design/>
- Amershi, S. ほか (2019). Guidelines for Human-AI Interaction. CHI 2019. <https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines/>
- Microsoft Learn. Tips for designing a great Power BI dashboard. <https://learn.microsoft.com/power-bi/create-reports/service-dashboards-design-tips>
- Microsoft Learn. Use parameters to visualize variables (what-if). <https://learn.microsoft.com/power-bi/transform-model/desktop-what-if>
- Microsoft Learn. Track OKR progress status（Viva Goals）. <https://learn.microsoft.com/viva/goals/track-okr-progress-status>
