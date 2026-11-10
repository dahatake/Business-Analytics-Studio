# CREDITS

制約 C-06 / NFR-LEGAL-001 に基づき、採用したライブラリ・素材とライセンスを記録します（版は `package-lock.json` の値）。

## 実行時の依存

| 名前 | 版 | ライセンス | 用途 |
|---|---|---|---|
| React / React DOM | 19.3.1 | MIT | UI |
| @fluentui/react-components（Fluent UI React v9） | 9.75.1 | MIT | デザインシステム（C-04） |
| @fluentui/react-icons（Fluent System Icons） | 2.0.345 | MIT | アイコン（F-3.1.4） |
| @fluentui/react-motion | 9.16.5 | MIT | Fluent のモーションを「動きを減らす」設定に従わせる（`MotionBehaviourProvider`） |
| d3 | 7.9.0 | ISC | 可視化（F-3.3.1） |
| d3-sankey | 0.12.3 | BSD-3-Clause | サンキー図 |
| fast-xml-parser | 5.12.0 | MIT | ローカルリレーで企業ニュースのRSSを検証・解析 |
| three | 0.187.0 | MIT | 3D 表示（FR-020 ほか） |
| topojson-client | 3.1.0 | ISC | 地図データの変換 |
| world-atlas | 2.0.2 | ISC | 国境の TopoJSON。元データは [Natural Earth](https://www.naturalearthdata.com/)（パブリックドメイン） |
| zustand | 5.0.16 | MIT | 状態管理 |
| zod | 4.6.7 | MIT | 顧客パックのスキーマ検証 |

## 開発・検証の依存

| 名前 | 版 | ライセンス |
|---|---|---|
| Vite / @vitejs/plugin-react | 8.3.5 / 6.1.2 | MIT |
| TypeScript | 7.0.2 | Apache-2.0 |
| Vitest | 5.1.0-beta.1 | MIT |
| jsdom | 30.1.3 | MIT |
| @testing-library/react | 16.3.3 | MIT |
| @playwright/test | 1.65.0-alpha-2026-11-01 | Apache-2.0 |
| axe-core / @axe-core/playwright | 4.14.0 | MPL-2.0 |

## 素材

| 素材 | 出所 | 権利 |
|---|---|---|
| 人物のバストアップ画像（10 人） | `src/ui/art/Portrait.tsx` がデータから SVG を生成 | 本リポジトリのコード（外部素材なし） |
| 顧客・製品のイラスト | `src/ui/art/Illustrations.tsx` がデータから SVG を生成 | 同上 |
| 3D モデル（工場・製品・地図・KPI タワー） | `src/modules/threed/` などがコードで生成 | 本リポジトリのコード（外部素材なし、FR-068） |
| BGM・操作音 | `src/audio/sound.ts` が Web Audio API で合成 | 同上（音声ファイルなし） |
| サンプルデータ（青空精機） | `src/data/sample.ts` | 架空の企業・人物・数値。実在の組織とは無関係 |
| 企業ニュースのメタデータ | Google News RSSと各記事の配信元 | 権利は各配信元に帰属。見出し・出典・公開日時・記事リンクのみを表示し、本文は転載しない。利用条件は各サービス・配信元に従う |

製品名「Microsoft Fabric」「Azure AI Vision」などは、解決策の例として名称だけを記載しています（商標は各社に帰属）。
