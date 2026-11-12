# トレーサビリティ（追加 UI 要求 F-3.x と要求定義書）

[要求定義書](requirements-definition.md) の要求と追加 UI 要求（F-3.1〜F-3.5）の実装と検証の対応です。第 1 段階で F-3.x を、第 2 段階で残りの領域（3D、インク、AI、生成パイプライン、レイアウト、ショー、企業・Project、議論、ユースケース、データカタログ、外部連携）を実装しました。外部への送信を伴う機能は、制約 C-03・C-07 のためモックと送信ゲートまでを実装し、末尾に「BLOCKED・未完」として理由を残します。

## 解釈と決定

| 曖昧だった点 | 決定 | 根拠・場所 |
|---|---|---|
| F-3.2.1「第 11.4 節の開閉・権限制御」 | 開閉は WCAG 2.2 SC 1.4.13（閉じられる・ホバーし続けられる・消えない）に合わせる。権限は、認証のないアプリ（C-01）のため、**社内向け／社外向け表示**（FR-002・FR-117 の `internal`）として実装する | `src/ui/cardController.ts`、`src/ui/cardSpecs.ts` |
| F-3.2.1「対象項目一覧を定義」 | 種類ごとに、カードに出す項目・社外向けで隠す項目・遷移の有無を 1 つの表にし、設定画面にも表示する | `cardSpecs`、設定画面「詳細カードの対象項目」 |
| F-3.2.3「関連先がない場合はリンクにしない」 | 出典（`source`）は詳細画面を持たないため `<button>`（カードだけ）として表示する | `cardSpecs.source.route = null` |
| F-3.3.3「比率に適さない指標」 | 間隔尺度（eNPS など）、基準値＝目標、目標が望ましい方向と逆、の 3 つはリングではなく数直線にし、理由を画面に出す | `src/domain/kpi.ts` |
| F-3.4.1「合意した負荷条件」 | 毎秒 20 件 × 8 秒、合格基準は表示遅延の p95 ≤ 100 ms（提案値） | `PARAMS.liveFeedLoad*` |
| F-3.4.2「第 11.7 節で合意」 | 提案値を置き、利用テストの計画を作成（未実施） | [usability-test.md](usability-test.md) |
| F-3.5.1「API の応答」 | ローカル API（`/api/*`）を Vite の dev／preview に載せ、`lang` → `Accept-Language` → 日本語の順で言語を決める | `src/api/handler.ts` |
| 「戻ると検索・絞込状態が復元」 | 検索・絞り込み・タブ・選択を URL のクエリに持ち、入力中は履歴を増やさない（`replaceState`）。スクロール位置も URL ごとに復元する | `src/state/router.ts`、`App.tsx` |
| オープニングの長さ | PARAM-011（15〜30 秒）はショー体験の値。本実装の起動演出は 4.5 秒でスキップ可、動きを減らす設定では表示しない | `PARAMS.openingDurationMs` |

## F-3.x → 実装 → 検証

| ID | 実装 | 第三者による検証（テスト） |
|---|---|---|
| F-3.1.1 デザインシステム・Immersive | Fluent UI v9、16 段階のブランドランプ（PARAM-017）、アクリル風の面と奥行き、Fluent のモーショントークン | axe の色コントラスト（全画面×2 言語＋ライトテーマ）`e2e/a11y.spec.ts` |
| F-3.1.2 人物のバストアップ | データから生成する SVG。10 人、女性 5・男性 5、20〜60 代の各年代に男女 1 人ずつ | `tests/data.test.ts`「portraits are balanced」、`e2e/visuals.spec.ts` |
| F-3.1.3 顧客・製品のイラスト | 業種・製品ごとのモチーフの SVG | `tests/data.test.ts`、`e2e/visuals.spec.ts`「imagery」 |
| F-3.1.4 アイコン | Fluent System Icons を種類ごとに 1 つ。図では色に加えて形も変える（色だけに頼らない） | `tests/data.test.ts`（全種類にアイコン・色・形、色は 3:1 以上） |
| F-3.1.5 BGM・効果音・映画的演出 | Web Audio で合成（既定は消音）、オープニング、パネルの登場、グラフのアニメーション。動きを減らす設定は OS に追従し、アプリでも上書き可 | `e2e/motion-feed.spec.ts`（reduced motion で animation 0s、オープニングなし、ミュートの保持） |
| F-3.2.1 詳細カード | ホバー（350 ms）・フォーカス・タッチで開き、Esc・外側のタップで閉じる。カードの上にポインターを移しても消えない。入力欄には出さない | `e2e/interaction.spec.ts`、`e2e/touch.spec.ts` |
| F-3.2.2 地図のポップアップ | 拠点マーカーは一覧と同じエンティティ ID のカード。Tab で移動、Enter で選択 | `e2e/interaction.spec.ts`「map popups」、`e2e/touch.spec.ts` |
| F-3.2.3 ドリルスルー | 参照はリンク（クリック・Enter）。選択はチェックボックスで分離。図では「選択（クリック・Enter）」と「詳細を開く」を分離 | `e2e/interaction.spec.ts`「drill-through」 |
| F-3.2.4 関係の可視化 | 顧客 → 案件 → 成果物 → 請求のレーン図（選択で上流・下流を強調）、段数 1〜3 の関係グラフ、関係の表 | `e2e/interaction.spec.ts`「business relationships」、`tests/data.test.ts` |
| F-3.3.1 動的な表現 | d3（force・geo・sankey・transition・zoom・drag） | `e2e/visuals.spec.ts`（重みで順位が変わる、段数でノード数が変わる、ホバーで強調） |
| F-3.3.2 最適な Visual | 表・ガント・サンキー・2×2・地図・リング／数直線・棒。各図に「この表現を選んだ理由」と代替の表 | `e2e/visuals.spec.ts`「every visual explains why」 |
| F-3.3.3 KPI の目標と達成度 | 名前・実績・目標・基準値・単位・望ましい方向を常に表示 | `tests/domain.test.ts`、`e2e/visuals.spec.ts` |
| F-3.3.4 前後比較 | 指標ごとに同じ単位・0 始まりの同じ軸。期間・対象（母集団）を明記し、元の数値の表を添える。最適化は最小費用流で厳密に解く | `tests/domain.test.ts`（総当たりとの一致、需要の一致）、`e2e/visuals.spec.ts` |
| F-3.4.1 ライブフィード | 更新時刻・鮮度（最新／遅延／停止中／一時停止中）・「シミュレーション」表示・表示遅延（p50／p95）。ホバー中は表示を止める（WCAG 2.2.2） | `tests/feed.test.ts`、`e2e/motion-feed.spec.ts`（負荷条件での p95） |
| F-3.4.2 使い方・容量レポート・サマリー | 最適化画面の 3 つのパネル | `e2e/visuals.spec.ts`。人による利用テストは [計画](usability-test.md) のみ |
| F-3.5.1 2 言語 | UI・サンプルデータ・API の応答 | `tests/i18n.test.ts`、`tests/api.test.ts`、`e2e/i18n.spec.ts`（英語表示に日本語が 1 文字もないこと） |
| F-3.5.2 言語トグル | 上部バーに配置。再読み込みなしで切り替え、`localStorage` に保持、`<html lang>` を更新 | `e2e/i18n.spec.ts` |
| F-3.5.3 翻訳の網羅をテストで強制 | 型（`Record<MessageKey, string>`）と実行時の検査。キーの欠落・空・余分・プレースホルダーの不一致で失敗する | `tests/i18n.test.ts`（壊した辞書で失敗することも確認） |

## 要求定義書の要求との対応（領域別）

各領域はモジュールとして実装し、モジュールごとに単体テスト・E2E・axe（日英）を持ちます。規約は [module-guide.md](module-guide.md) を参照してください。

| 領域 | 主な要求 | 実装 | 検証 |
|---|---|---|---|
| 共通基盤 | FR-137〜139（データの分離）、FR-046（元に戻す）、C-03、FR-101、FR-241 | `src/state/projects.ts`（Project ごとの保存領域）、`src/state/history.ts`、`src/ai/*`（C-03 ゲート・予算・社外秘の除外）、`src/main.tsx`（`public/data/pack.json` の読み込み）、`extensions`（任意項目） | `tests/projects.test.ts`、`tests/ai-core.test.ts` |
| 登録済み企業（顧客）・Project の名前変更と削除 | FR-137・FR-138・FR-139・FR-306 の追加仕様（[要求定義書 §3.9](requirements-definition.md#39-登録済み企業顧客とprojectの名前変更削除)）。両画面の操作、空名・重複名の拒否、確認・取消、識別子の維持、削除範囲、選択状態と再読み込み後の整合性 | `src/state/projects.ts`、`src/modules/project/useProjectManagement.tsx`（共通ダイアログ）、`LaunchScreen.tsx`、`ProjectsScreen.tsx`、`src/data/packStore.ts`、`src/modules/ink/storage.ts` | `tests/projects.test.ts`（名前・識別子・分離・削除）、`e2e/project-management.spec.ts`（両画面・取消・永続化・日英・狭い画面・axe・パックと手書きボードの IndexedDB 削除）、既存の `e2e/project.spec.ts`・`e2e/pack-import.spec.ts` |
| 企業・Project・分析・議論 | FR-012、FR-019、FR-042、FR-044〜057、FR-133〜140、FR-144、FR-148〜149、FR-153〜154、FR-176、FR-186〜187、FR-219、FR-266〜268 | `src/modules/project/`（/home、/projects、/analysis、/discussion、作業先メニュー、ステッパー、全量エクスポート） | `tests/project.test.ts`（Markdown の往復など）、`e2e/project.spec.ts` |
| 起動の流れ・データ管理（顧客パックの取り込み） | FR-076（オープニングはアプリ名だけ）、FR-144・FR-267（起動時の選択画面）、FR-302〜304（アップロード・ブラウザー内の検証・人の確認・全か無かの取り込み）、FR-306〜307（2026-11-10 改訂: 2 段目の顧客パック作成が `<packId>.zip` を返し、そのまま取り込む。AC-898）、FR-308〜310（公開 Web 調査の指示と送信前の分離〈1 段目は Web モードで公開の入力だけ、2 段目は Web 検索をオフ〉・全区分の取得指示・出典の URL/確認日・取得報告・取り込みの厳格化・拡張の検査・`dataCatalog` の Project での利用。AC-888〜AC-898 は要求定義書 §3.8）、FR-241（任意項目）、PARAM-142 | `src/state/launch.ts`・`src/ui/Opening.tsx`・`src/modules/project/LaunchScreen.tsx`（スプラッシュ→企業と Project の選択→Project 画面）、`src/data/packImport.ts`（```json の抽出・PART の結合・形の整形・`verifyPack`）、`src/data/zipRead.ts`（Copilot の zip から JSON を読む。無圧縮・deflate、サイズ上限）、`src/data/verify.ts`（CLI と共有する唯一の検証）、`src/data/collection.ts`（取得報告の 24 区分）、`src/data/extensionSchemas.ts`・`src/modules/usecases/catalogSchema.ts`（拡張のスキーマ）、`src/data/packStore.ts`（Project ごとの IndexedDB）、`src/main.tsx`（作業先のパックで起動）、`src/modules/project/PackDataScreen.tsx`（/data）、`docs/copilot-customer-pack-prompt.md`（Microsoft 365 Copilot 用の 2 つのプロンプトの原本） | `tests/pack-import.test.ts`（PART に分けたお手本パックの往復が CLI の verify に合格・出典のない数値はエラー・修正用プロンプト・保存の全か無か・プロンプトとスキーマの食い違いの検出・`docs/pack.schema.json` の全プロパティとプロンプトの照合・調査プロンプトの入力が公開の 3 つだけ・取得報告・PART の欠落/矛盾の拒否・拡張と最適化の検査）、`tests/zip-read.test.ts`（zip の読み取り・上限・PART の結合）、`e2e/pack-import.spec.ts`（2 つのプロンプトの表示→修正用プロンプト→貼り付け＋ファイル→確認→取り込み→画面に反映→デモへの切り替え→削除。英語 UI で zip を選んで取り込み。axe・日英）、`e2e/project.spec.ts`（起動の選択画面）、`e2e/motion-feed.spec.ts`（オープニングに顧客名が出ない） |
| 顧客パックの実施記録 | FR-133・FR-135・FR-303・FR-308・FR-310 の補足（[要求定義書 §3.11](requirements-definition.md#311-顧客パックの実施記録)、D-16） | `src/data/extensionSchemas.ts`・`verify.ts`、`src/modules/project/packGenerate.ts`・`analysisReadiness.ts`・`EngagementsPanel.tsx`、`docs/pack.schema.json`・`copilot-customer-pack-prompt.md` | `tests/ops-pipeline.test.ts`・`pack-generate.test.ts`・`engagements-panel.test.tsx`・`pack-import.test.ts`、`e2e/pack-import.spec.ts`。実サービスの再計測は未実施 |
| ステップの成果物・ToDo | FR-136（5 ステップ）、FR-050（人の決定と AI の提案の区別）、FR-011（モックの表示）、C-03 | `src/modules/project/deliverables.ts`（成果物の定義・完了条件・決定的な妥当性チェック）、`deliverableDraft.ts`（「Copilotでドラフト作成」。専用の用途 `deliverableDraft` で `aiComplete` を通り、未承認の間は顧客パックから作るモック。D-9）、`deliverablesUi.tsx`（ライブの下の ToDo 帯。自動で開くのは固定の領域が画面の高さの 35% 以内のとき）、`DeliverablesScreen.tsx`（/deliverables。施策計画の投資回収の上限を Project ごとに設定）。数値の照合（`asis-reconcile`）は KPI を正とする | `tests/project-deliverables.test.ts`（空の Project は失敗・デモ＋ドラフト＋確認で全ステップ完了・壊したデータの反例・数値の不一致の反例・構築期間を含む回収と上限の変更・自動で開く規則・専用の用途が未承認）、`e2e/project-deliverables.spec.ts`（axe・日英） |
| ワークスペース | FR-013〜015、FR-109〜113、FR-142〜143、FR-150〜152、FR-173〜175、FR-183〜185、FR-215〜216、FR-295〜300、FR-305、NFR-UX-001・006〜008 | `src/modules/workspace/`（純粋なレイアウトエンジン、ペルソナ別レイアウト、コマンドパレット） | `tests/workspace-*.test.ts`、`e2e/workspace.spec.ts` |
| ショー・プレゼンテーション | FR-016、FR-057、FR-063、FR-076〜085、FR-177〜179、FR-290、NFR-A11Y-008 | `src/modules/show/` | `tests/show.test.ts`、`e2e/show.spec.ts`（最初のシーン 2 秒以内など） |
| ポート非依存の端末保存 | [要求定義書 §3.10](requirements-definition.md#310-ポートに依存しない端末保存2026-11-11-追加要求)（2026-11-11 追加要求） | `scripts/lib/device.ts`・`deviceProtocol.ts`（SQLite・トランザクション・版照合・移行バックアップ・同一origin）、`src/data/deviceStorage.ts`（移行・送信待ち保護）、`src/main.tsx`・`bootstrap.tsx`（保存先の初期化を待って起動）、`src/ui/DeviceStorageStatus.tsx`（保存状態・失敗・復旧コピー）、`vite.config.ts`・`scripts/lib/serve.ts`（全起動経路） | `tests/device-storage.test.ts`、`e2e/device-storage.spec.ts`（独立ブラウザー・異なるポート・再起動・競合・失敗・破損）、既存のProject・パック・インク・ポップアウト試験 |
| インク・ホワイトボード | FR-086〜099、NFR-PERF-004 | `src/modules/ink/`（依存なしの PDF 1.4 出力、端末保存、自動保存） | `tests/ink.test.ts`（PDF の xref を検証）、`e2e/ink.spec.ts`（20 000 本での描画時間） |
| 3D | FR-018、FR-020〜021、FR-023、FR-030〜034、FR-036、FR-040、FR-065〜069、FR-146〜147、FR-217 | `src/modules/threed/`（three.js、手続き生成のモデル、WebGL がない場合は 2D） | `tests/threed.test.ts`、`e2e/threed.spec.ts`（最初のフレーム・大きさの追従） |
| 関係グラフ・Twin・空間 | FR-212〜214、FR-218、FR-235〜241、FR-245〜248、NFR-A11Y-010 | `src/modules/graph/` | `tests/graph.test.ts`、`e2e/graph.spec.ts` |
| ユースケース・データカタログ | FR-043、FR-155〜167、FR-169〜172、FR-180、NFR-A11Y-006〜007、NFR-UX-010〜012 | `src/modules/usecases/` | `tests/usecases.test.ts`、`e2e/usecases*.spec.ts` |
| 生成 AI | FR-010〜011、FR-017、FR-132、FR-167〜168、FR-182、FR-274〜292、NFR-SEC-001・002・005・012、NFR-COST-001 | `src/modules/ai/`、`server/`（localhost だけの中継。鍵は AES-256-GCM で暗号化） | `tests/ai-*.test.ts`、`e2e/ai.spec.ts`（鍵がページと通信に出ないこと） |
| 生成パイプライン・ブランド・外部連携 | FR-058〜064、FR-100〜108、FR-118〜131、FR-141、FR-188〜203、NFR-SEC-006・008、NFR-OPS-001 | `scripts/bas.ts`（research・build・verify・launch・package・feedback・integrations）、`src/modules/ops/`、`docs/integration-catalog.md`、`docs/pack.schema.json`、起動・セットアップのスクリプト | `tests/ops-*.test.ts`、`e2e/ops.spec.ts`、壊したパックで `verify` が終了コード 1 |

## 残っている項目（2026-11-09 の決定の後）

決定の記録・選択肢・理由は [decision-guide.md](decision-guide.md)、人や実機による測定の手順は [measurement-plan.md](measurement-plan.md) にあります。

### 決定に従って完了したもの

| 項目 | 状態 | 実装と検証 |
|---|---|---|
| C-03 の基準表（D-1・D-12・D-13） | 実装では「現状の説明 × Foundry」に加えて `packBuild` と固定の合成文による `connectionTest` を許可。他の用途（D-9 の `deliverableDraft` を含む）は未承認。要求定義書 §3.1 はこれらの決定を未反映 | `src/ai/policy.ts`、中継の転送。スタブの「Foundry」相手の E2E で、送信の本文・API キーのヘッダー・費用の記録・予算超過後の送信 0 件を確認 |
| C-03 の利用者向け確認画面 | 用途ごとの送信先・送るデータ・費用と承認状態を平易に表示。未決行の画面上の承認は不可 | `src/modules/ai/AiPolicyScreen.tsx`、`e2e/ai.spec.ts`（日本語・英語の表示とアクセシビリティ） |
| internal の外部送信（D-2） | 許可（Q-055 を改める） | 送信前の確認に internal と人物の件数を表示。社外向け表示の非表示と FR-219 は維持 |
| 予算（D-3） | 月 100,000 円の 1 つの枠。設定画面で変更可 | `tests/ai-core.test.ts`、AI の接続設定の画面 |
| 権利処理（D-4） | 起動前に済んでいる前提。警告を表示 | AI の接続設定・送信前の確認・実接続中のバナー |
| 中継の保護と CSP（D-5） | 既定は 127.0.0.1 の完全一致・起動ごとのトークン・Origin 必須。環境変数で変更可。CSP を適用 | [relay-config.md](relay-config.md)、`build/csp.ts`。全 32 経路で CSP の違反 0 件（`e2e/csp.spec.ts`） |
| 旧設定の移行（D-6） | P-01 のとおり | 4 状態の単体テスト・E2E |
| 削除と保持（D-7） | P-03 のとおり。利用量の記録は 13 か月、削除は明示操作だけ | 設定画面「データの保持と削除」、AI の接続設定の画面 |
| 測定の条件（D-8） | P-04 と追加 2 点 | `src/config/measurement.ts`、`npm run measure`、`npm run kpi1`、性能試験の直列実行 |
| ユースケースの書き戻し（I-1） | 取り込み候補として示し、利用者が選ぶ | `e2e/project-usecase-import.spec.ts` |
| 「Copilot の案」の表示（I-2） | 対象の画面に、反映済みの印と差分を表示 | AI のモジュールの E2E |
| 2D の段階表示（I-3） | 地図のラベルを優先度で出し分け、ヒステリシスあり | `tests/mapLabels.test.ts`、`e2e/map-lod.spec.ts` |
| 被写界深度（I-4） | 既定で無効。High 品質と演出が有効なときだけ。FPS が下がると最初に切る | 3D のモジュールの単体テスト・E2E |
| Windows での鍵の保護（I-6） | DPAPI で保護（使えない場合は鍵ファイルに戻し、画面に表示） | `tests/ai-relay.test.ts` |
| ショート動画のファイル出力（FR-081） | 画面の録画（Screen Capture API）で WebM を保存 | `e2e/show-video.spec.ts`（ファイルの先頭が WebM の EBML ヘッダーであること） |
| ディスプレイ間の移動（FR-298） | 別ウィンドウで開き、Window Management API があればディスプレイを選んで配置 | `e2e/workspace-popout.spec.ts` |
| 「動きを減らす」と Fluent UI のモーション | 統合の監査で発見。CSS では止まらない Fluent のモーションも止まるように修正 | `e2e/motion-feed.spec.ts` |

### 人・実機・未承認の行が必要なもの

| 項目 | 状態 | 理由と次の手順 |
|---|---|---|
| KPI-1（実 LLM での生成時間） | 測定待ち | `packBuild` は D-12 で許可済みだが、要求定義書 §3.1 への反映と [measurement-plan.md](measurement-plan.md) M-1 の実測は未完了 |
| 4K・60 fps（KPI-5）、移動中の 30 fps（PARAM-065） | 測定待ち | GPU と 4K の表示装置を持つ基準端末で M-2。ヘッドレスの結果は証拠にしない |
| 実機のペンと複数指のタッチ | 確認待ち | M-3 |
| 利用テスト（F-3.4.2） | 実施待ち | M-4 |
| Safari・Firefox での動画の保存 | 未確認 | この環境には Chromium しかない。未対応のときは案内を表示する作り |
| 要求定義書への反映（D-12〜D-15） | 未反映 | 決定と実装は [decision-guide.md](decision-guide.md) §0 に記録。要求定義書 §3.1・生成の正式な要求 ID と PARAM への反映が残る。D-16 は §3.11 に反映済み。編集者の限定は廃止し、承認条件・ID 管理は維持 |
