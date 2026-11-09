# Business Analytics Studio

法人顧客との商談で、課題・関係・KPI・最適化の結果を見せるローカル Web アプリです。要求は [docs/requirements-definition.md](docs/requirements-definition.md) と、追加 UI 要求 F-3.1〜F-3.5 です。対応と見送りは [docs/traceability.md](docs/traceability.md) にあります。

データはすべて架空のサンプル（青空精機）で、画面にも「サンプルデータ」と表示します。外部サーバーへの送信はありません。

## 起動

Node.js 22.18 以上と npm が必要です。

Windows では、初回にセットアップした後、ルート直下の [run.cmd](run.cmd) をダブルクリックするか、コマンドプロンプトから実行してください。

```bat
powershell -ExecutionPolicy Bypass -File setup.ps1
run.cmd
```

ビルド済みのアプリをローカル API・中継機能付きで起動します。表示された URL（既定: `http://127.0.0.1:4173`）をブラウザーで開いてください。停止は Ctrl+C です。別のフォルダーからの実行にも対応し、起動時のダウンロードや自動ビルドは行いません。コード更新後は `npm.cmd run build` を実行してください。前提ツール・依存関係・ビルドの不足や起動失敗はメッセージと非ゼロの終了コードで通知します。

ポートを変える場合は `run.cmd --port 4180` と指定できます。ポートが使用中なら、別のポートへ自動変更せず失敗します。

開発時:

```powershell
npm install
npm run dev        # http://127.0.0.1:5173
```

配布用のビルドを確認するとき:

```powershell
npm run build
npm run preview    # http://127.0.0.1:4173
```

## 検証

| コマンド | 内容 |
|---|---|
| `npm run typecheck` | TypeScript（strict）の型検査。翻訳キーの欠落もここで失敗する |
| `npm test` | Vitest: 翻訳の網羅、データの整合性、人物画像の年齢・性別の均衡、KPI の表現の選択、最適化（総当たりとの一致）、API の 2 言語応答 |
| `npm run e2e` | Playwright（Chromium・Pixel 7 のタッチ）: 詳細カード、ドリルスルーと状態の復元、地図、言語の即時切替、reduced motion・ミュート、ライブフィードの負荷時の遅延、axe（WCAG 2.2 AA、全画面×2 言語） |
| `npm run verify` | 上のすべてを順に実行（性能の試験は他の試験と分け、単独で直列に流します） |
| `npm run measure` | 測定の道具（D-8）。基準端末で `-- --headed` を付けて実行し、`logs/measurements/` に生のフレーム間隔・環境・判定を保存 |
| `npm run kpi1 -- <顧客名>` | `logs/timing.json` から KPI-1（生成から起動まで）の p50 と最大値を集計 |

E2E は、初回だけ `npx playwright install chromium` が必要な場合があります。スタブの「Foundry」を相手にした実接続の試験は `$env:BAS_RELAY_TEST_OUTBOUND='1'` のときだけ動きます。E2E は利用者の鍵の保存場所（`.bas-local`）を使わず、試験専用のフォルダーを使います。`npm run e2e` は自動でビルドして 4173 番で起動します（起動済みのサーバーがあれば再利用します）。

## 画面

左のメニューは「はじめに」「分析」「議論と共同作業」「発表」「管理」に分かれています。

| 画面 | 内容 |
|---|---|
| メイン画面 | QuickStart（企業の登録 → Project の作成 → 分析の開始）、補足パネル |
| 概要・関係・地図・物の流れ・計画・最適化・一覧・詳細 | KPI、優先順位、関係図、地図、サンキー図、ガント、最適化、一覧（ドリルスルー） |
| 分析 | SWOT・ファイブフォース・バリューチェーン・3C・BSC、KPI と OKR |
| 関係グラフと Twin | 意味ラベル付きの関係グラフ、意味的ズーム、Twin ビュー、空間ビュー（2D／3D／Graph） |
| 3D ビュー | デジタルツイン、3D の拠点と流れ、KPI タワー、AsIs／ToBe アーキテクチャ |
| データカタログ | データエンティティ、ユースケースとの対応表、企業データカタログの取り込みと突合、2D／3D ビュアー |
| ワークスペース | ペルソナ別のレイアウト（移動・スナップ・ピン止め・最大化）、コマンドパレット（Ctrl+K） |
| 議論 | 論点のツリー、決定事項・次のアクション、元に戻す、変更履歴、Business ⇔ IT のレンズ |
| ボード | ペン・タッチのインク、付箋、データカード、PDF／Markdown 出力 |
| ユースケース | 登録・編集、アニメーション、ストーリーボード（約 30 秒）、ミニ・モックアプリ |
| AI アシスタント | 検索とチャット（モック）、ストーリー動画 |
| プレゼンテーション | 番組構成、ペルソナ別ストーリー、ショーコントロールバー |
| 企業と Project・外部連携・運用とブランド・AI の接続設定・設定 | 管理の画面 |

上部のバーには、作業先（デモ／Project）、改善ステップ、全量エクスポート、言語の切り替え（1 段目）と、コマンド、プレゼンテーション、現状の説明、Copilot で分析実行、画面へのインク、表示の切り替え（2 段目）があります。

## 生成 AI について

生成 AI への送信は、要求定義書の制約 C-03 の用途別の基準表で許可した用途だけに限られます。2026-11-09 の決定（[判断資料](docs/decision-guide.md) §0）で、**「現状の説明」× Microsoft Foundry の 1 行だけ**を許可しています。それ以外の用途はモックが答え、画面に「モック」と理由を表示します。

実際に送るには、AI の接続設定（`/ai-settings`）で次をすべて行います。

1. Foundry のエンドポイント・デプロイ名・API キーを保存する（キーは localhost の中継が暗号化して保存し、Windows では DPAPI で保護します。画面にも通信にも再表示しません）。
2. 入力・出力の単価（円／100 万トークン）を入れる（未入力なら送信しません）。
3. 実接続を有効にする。
4. 送信のたびに、送る内容（internal・人物の件数を含む）と見積もりの費用を確認する。

月の総予算は 100,000 円の 1 つの枠で、設定画面で変えられます（警告 80%、停止 100%）。外部への送信は、**契約・利用規約・個人情報などの権利処理が、アプリの起動前に済んでいる前提**です（画面にも警告を表示します）。

中継の保護（待ち受けるアドレス・Host・Origin・外向きの接続先）は環境変数で変えられます。既定は `127.0.0.1` の完全一致だけです。Azure などへ展開するときの設定と注意は [docs/relay-config.md](docs/relay-config.md) にあります。ビルドした画面には Content Security Policy（`unsafe-eval` なし、外部の接続先なし）を付けています。

## 生成パイプライン（CLI）

```powershell
npm run bas -- research <顧客名>     # 調査キャッシュ（外部の調査は BLOCKED。サンプルを使ったことを記録）
npm run bas -- build <顧客名>        # work/<顧客名>/ に雛形と顧客パックを用意（不正な項目だけを自己修正）
npm run bas -- verify <pack.json>   # 受け入れ判定。原因と対処を表示し、不合格なら終了コード 1
npm run bas -- launch <顧客名>       # 127.0.0.1 で起動
npm run bas -- package <顧客名>      # オフラインで動く配布物
npm run integrations:check          # 外部連携カタログの検査
```

所要時間は `logs/timing.json` に記録します。起動・セットアップ用に `start.ps1`／`start.sh`／`start.command`、`setup.ps1`／`setup.sh` があります。顧客パックの形式は [docs/pack.schema.json](docs/pack.schema.json) です。

## 操作

- **詳細カード**: 参照項目にポインターを置く（0.35 秒）、Tab でフォーカス、またはタップで開きます。Esc か外側のタップで閉じます。
- **ドリルスルー**: 参照項目をクリックするか Enter で詳細へ。ブラウザーの「戻る」や画面の「戻る」で、検索・絞り込み・選択・スクロール位置が戻ります。
- **社外向け表示**: 上部の「社内向け表示」ボタンで切り替えます。社外秘の項目と、金額などの社外秘の値を隠します。
- **動きを減らす**: OS の設定に従います。上部のボタンか設定画面で上書きできます。
- **サウンド**: 最初は消音です。上部の「サウンド」で BGM と操作音が鳴ります。

## 構成

```
scripts/      生成パイプラインの CLI（bas.ts）
server/       localhost の中継（鍵の暗号化保管、AI 送信の拒否）
src/
  app/        画面の登録（modules.ts）と、各モジュールの上部バー・オーバーレイ
  ai/         C-03 の送信ゲート、予算、社外秘の除外、AI 呼び出しの入口
  modules/    機能モジュール（workspace, show, ink, threed, graph, project, usecases, ai, ops）
  api/        ローカル API（Vite の dev/preview に載せる。届かなければブラウザー内で同じ処理を実行）
  audio/      Web Audio による BGM・操作音
  charts/     d3 の図（KPI、前後比較、優先順位、レーン図、関係グラフ）
  config/     受け入れの観点の具体値（PARAMS）
  data/       zod スキーマ、サンプルパック、関係の構築
  domain/     KPI の表現選択、最適化（最小費用流）、優先順位、サマリー
  i18n/       日本語・英語の辞書（ja.ts がキーの正本）
  screens/    画面
  state/      設定（localStorage）、ルーター（URL）、ライブフィード、動きの設定
  ui/         詳細カード、参照、画像、パネルなど
tests/        Vitest
e2e/          Playwright
```

## 補足

- ライブフィードは **シミュレーション** です。遅延の測定は設定画面からも実行できます（負荷条件は `src/config/params.ts`）。
- axe の検査では、Fluent UI のフォーカス管理（Tabster）が `<body>` 直下に置く `data-tabster-dummy` 要素だけを除外しています（axe の既知の誤検知）。
- 決定の記録と判断資料は [docs/decision-guide.md](docs/decision-guide.md)、人や実機による測定の手順は [docs/measurement-plan.md](docs/measurement-plan.md)、機能モジュールの規約は [docs/module-guide.md](docs/module-guide.md)、要求との対応と BLOCKED の一覧は [docs/traceability.md](docs/traceability.md) にあります。
- 利用テスト（F-3.4.2）は [計画](docs/usability-test.md) のみで、まだ実施していません。
- ライセンスは [LICENSE](LICENSE)、依存と素材は [CREDITS.md](CREDITS.md) を参照してください。
