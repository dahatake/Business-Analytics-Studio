---
title: 手順書
---

# Business Analytics Studio 手順書（ポータブル版）

この手順書は、Business Analytics Studio（以下「BAS」）を**ご自身の PC で、ご自身の AI リソースを使って**使い始める方のためのものです。インストールと管理者権限は不要です。zip を展開して起動ファイルを開くと、ブラウザーに画面が表示されます。

| 項目 | 内容 |
| --- | --- |
| 所要時間 | 約 10 分（ダウンロードを除く） |
| 必要なもの | Windows 10/11（x64・Arm64）・macOS（Apple シリコン・Intel）・Linux（x64・Arm64。glibc）の PC、ブラウザー（Edge・Chrome・Safari・Firefox） |
| AI を使う場合 | 次のどちらか。どちらも**お客様ご自身の契約**を使います。<br>・Microsoft Foundry（Azure OpenAI）のリソースと、そのリソースへのアクセス権<br>・GitHub Copilot のライセンス |
| 権限 | 管理者権限は不要です。会社のポリシーでユーザー フォルダーのプログラム実行が禁止されている場合は、[IT 部門の方へ](#it) を IT 部門にお渡しください。 |

目次

1. [ダウンロード](#download)
2. [ファイルの確認（任意）](#verify)
3. [ブロックの解除と展開](#extract)
4. [起動](#start)
5. [AI の設定](#ai)
6. [ネットワークの確認](#network)
7. [作業を始める](#work)
8. [終了・再起動・更新・削除](#lifecycle)
9. [うまくいかないとき](#trouble)
10. [IT 部門の方へ](#it)

<a id="download"></a>

## 1. ダウンロード

### ダウンロード ページから（おすすめ）

1. [ダウンロード ページ](./) を開きます。
2. 「この PC 向けのファイル」に、お使いの PC に合う zip が表示されます。［ダウンロード］を押して保存します。

![ダウンロード ページ。最新版と、この PC 向けのダウンロード ボタンが表示されている](images/01-download-page.png)

### github.com の Releases から

ダウンロード ページを開けない場合は、[Releases](https://github.com/dahatake/Business-Analytics-Studio/releases/latest) を開き、「Assets」から次の表に従って zip を選びます。`.sha256` で終わるファイルはダウンロード不要です。

| お使いの PC | ファイル名の末尾 | 起動ファイル |
| --- | --- | --- |
| Windows 10/11（Intel・AMD。ほとんどの PC） | `-win-x64.zip` | `start.cmd` |
| Windows 11（Arm。Snapdragon など） | `-win-arm64.zip` | `start.cmd` |
| Mac（Apple シリコン。M1 以降） | `-mac-arm64.zip` | `start.command` |
| Mac（Intel） | `-mac-x64.zip` | `start.command` |
| Linux（x64） | `-linux-x64.zip` | `start.sh` |
| Linux（Arm64） | `-linux-arm64.zip` | `start.sh` |

**Windows が Intel・AMD か Arm かわからないとき:** ［設定］→［システム］→［バージョン情報］の「システムの種類」を見ます。「ARM ベース プロセッサ」とあれば `win-arm64`、「x64 ベース プロセッサ」なら `win-x64` です。

**Mac の種類がわからないとき:** アップル メニュー →［この Mac について］で「チップ」に Apple M… とあれば `mac-arm64`、「プロセッサ」に Intel とあれば `mac-x64` です。

<a id="verify"></a>

## 2. ファイルの確認（任意）

社内規定でダウンロードしたファイルの確認が必要な場合に行います。

### ハッシュ値（SHA-256）

Release の `SHA256SUMS.txt`（Release ノートにも同じ内容があります）に書かれた値と、次のコマンドの結果が一致することを確かめます。

Windows（PowerShell）:

```powershell
Get-FileHash .\BusinessAnalyticsStudio-<版>-win-x64.zip -Algorithm SHA256
```

macOS / Linux:

```sh
shasum -a 256 BusinessAnalyticsStudio-<版>-mac-arm64.zip
```

### 作成元の証明（GitHub CLI をお使いの場合）

zip は GitHub Actions がこのリポジトリーのソースから作成し、作成元の証明（build provenance attestation）を付けています。次のコマンドで、このリポジトリーのワークフローで作られたことを確認できます。

```sh
gh attestation verify BusinessAnalyticsStudio-<版>-win-x64.zip --repo dahatake/Business-Analytics-Studio
```

<a id="extract"></a>

## 3. ブロックの解除と展開

### Windows

1. ダウンロードした zip を右クリック →［プロパティ］を開きます。
2. ［全般］タブの下にある「セキュリティ: このファイルは他のコンピューターから取得したものです。…」の［許可する］にチェックを入れ、［OK］を押します。<br>（この項目が表示されない場合は、そのまま次へ進みます。）
3. zip を右クリック →［すべて展開］で、**ドキュメント**などのフォルダーに展開します。

PowerShell で行う場合:

```powershell
Unblock-File .\BusinessAnalyticsStudio-<版>-win-x64.zip
Expand-Archive .\BusinessAnalyticsStudio-<版>-win-x64.zip -DestinationPath $HOME\Documents
```

> **注意:** zip を開いた画面（エクスプローラーの zip の中）から `start.cmd` を直接ダブルクリックしないでください。必ず展開してから起動します。OneDrive で同期しているフォルダーや、ネットワーク ドライブも避けてください。

### macOS

zip をダブルクリックすると、同じ場所にフォルダーが展開されます。必要に応じて［書類］などへ移動します。

### Linux

```sh
unzip BusinessAnalyticsStudio-<版>-linux-x64.zip -d ~/Applications
```

<a id="start"></a>

## 4. 起動

### Windows

展開したフォルダーの `start.cmd` をダブルクリックします。

- 「Windows によって PC が保護されました」（SmartScreen）と表示された場合は、［詳細情報］→［実行］を押します。
- 「発行元を確認できませんでした」（セキュリティの警告）と表示された場合は、［実行］を押します。<br>手順 3 でブロックを解除すると、どちらも表示されなくなります。

黒いウィンドウ（コンソール）が開き、次のように表示されたあと、ブラウザーに BAS の画面が開きます。

```text
Business Analytics Studio: http://127.0.0.1:4300/
  データ / data: C:\Users\<ユーザー名>\AppData\Local\BusinessAnalyticsStudio
  ネットワーク / network: direct [none]; system certificates: on
  このウィンドウを閉じると終了します / Close this window (or press Ctrl+C) to stop.
```

「ネットワーク」の行は、会社のプロキシを使う環境では `proxy http://…` や `PAC http://…` のように表示されます。

> **黒いウィンドウは、作業中は閉じないでください。** 閉じると BAS が終了します（作業内容は保存済みです）。最小化してかまいません。

### macOS

`start.command` をダブルクリックします。「開発元を検証できないため開けません」と表示された場合は、次のどちらかを行ってから、もう一度ダブルクリックします。

- ［システム設定］→［プライバシーとセキュリティ］を開き、画面下部の `start.command` についてのメッセージの横にある［このまま開く］を押します。
- ターミナルで次を実行します（`<展開したフォルダー>` はフォルダーをターミナルへドラッグすると入力できます）。

  ```sh
  xattr -dr com.apple.quarantine <展開したフォルダー>
  ```

macOS 15（Sequoia）以降では、右クリック →［開く］による許可はできなくなりました。

### Linux

```sh
~/Applications/BusinessAnalyticsStudio-<版>-linux-x64/start.sh
```

### 起動後の画面

最初にオープニング画面が表示され、続いて「企業と Project を選ぶ」画面になります。

![オープニング画面](images/02-opening.png)

ブラウザーが自動で開かない場合は、黒いウィンドウに表示されたアドレス（例: `http://127.0.0.1:4300/`）をブラウザーに入力します。

<a id="ai"></a>

## 5. AI の設定

AI を使わなくても、データの登録・閲覧・分析は行えます。AI を使う場合は、次の手順で**お客様ご自身の** AI リソースを設定します。

1. 画面右上の［設定］を押します。

   ![企業と Project を選ぶ画面。右上の［設定］を枠で示している](images/03-launch-screen.png)

2. 左の［AI 設定］を選びます。最初に表示される注意書き（契約と権利の確認）を読み、「接続先」で使う AI を選びます。

   ![AI 設定。接続先として Microsoft Foundry と GitHub Copilot SDK を選べる](images/04-ai-settings.png)

### A. Microsoft Foundry（Azure OpenAI）を使う

Azure 上にお客様の Microsoft Foundry（または Azure OpenAI）リソースと、モデルのデプロイが必要です。

1. 「接続先」で［Microsoft Foundry］を選びます。
2. 「認証方式」で［Microsoft Entra ID］を選び、［Microsoft アカウントでサインイン］を押します。ブラウザーで組織のアカウントにサインインします。

   ![Microsoft Entra ID を選び、［Microsoft アカウントでサインイン］を枠で示している](images/05-ai-foundry-entra.png)

3. サインイン後、一覧からアクセスできる Foundry リソースとデプロイを選びます。
4. テスト送信の説明を確認するチェックを入れ、［接続をテストして保存］を押します。成功すると保存されます。

API キーを使う場合は、「認証方式」で［API キー］を選び、Azure ポータルで確認したエンドポイント・デプロイ名・キーを入力します。キーは PC 内で OS の保護機能により暗号化して保存され、ブラウザーやほかの PC には送られません。

> Entra ID でサインインするには、そのアカウントに Foundry リソースへのアクセス権（例: 「Cognitive Services OpenAI User」ロール）が必要です。組織の条件付きアクセスによっては、IT 部門の許可が必要な場合があります。

### B. GitHub Copilot を使う

GitHub Copilot のライセンスと、PC 上の **GitHub Copilot CLI** でのサインインが必要です。BAS は GitHub のトークンを扱いません。

1. GitHub Copilot CLI をインストールします（いずれか 1 つ）。
   - Windows: `winget install GitHub.Copilot`
   - macOS / Linux: `brew install --cask copilot-cli`、または `curl -fsSL https://gh.io/copilot-install | bash`
   - Node.js 22 以降がある場合: `npm install -g @github/copilot`

   詳しくは GitHub Docs の「[Installing GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli)」を参照してください。
2. ターミナルで `copilot` を起動し、`/login` と入力して GitHub にサインインします。サインインが済んだら `/exit` で閉じます。
3. BAS の［AI 設定］で「接続先」に［GitHub Copilot SDK］を選び、［サインイン状態とモデルを確認］を押します。
4. 使うモデルを選び、［モデルを中継プロセスに保存］を押します。

   ![GitHub Copilot SDK を選び、［サインイン状態とモデルを確認］を枠で示している](images/06-ai-copilot.png)

### 実接続の有効化

AI に資料を送るには、［AI 設定］の下部にある「実接続の有効化」で、送信内容への同意にチェックを入れます。同意するまで、AI へは業務データを送りません。

<a id="network"></a>

## 6. ネットワークの確認

［AI 設定］の［ネットワークを確認］を押すと、BAS が使うインターネット接続の経路（プロキシの有無）と、主な接続先に届くかを表示します。この確認では業務データや鍵は送りません。

![ネットワークの確認結果。各接続先に「接続可」と表示されている](images/07-network-check.png)

- 「接続可」: 問題ありません。
- 「接続不可」: 会社のプロキシやファイアウォールで遮断されている可能性があります。[うまくいかないとき](#trouble) を参照するか、[IT 部門の方へ](#it) を IT 部門にお渡しください。

プロキシと社内のルート証明書は、通常は**自動で** OS の設定を使います。設定は不要です。

<a id="work"></a>

## 7. 作業を始める

［閉じる］で設定を閉じ、「企業と Project を選ぶ」画面に戻ります。

- **まず試す:** 「サンプル企業」の［開く］を押すと、お手本のデータで操作を試せます。
- **自社の作業を始める:** 「新しく始める」に企業名と Project 名を入力し、［作成して開く］を押します。

![サンプル企業の［開く］を枠で示している](images/08-open-demo.png)

Project を開くと、5 つのステップ（現状分析 → … ）に沿って作業を進める画面が表示されます。上部の「次にやること」と「次に行うべきタスク」から始めてください。

![サンプル企業の Project を開いた画面](images/09-home.png)

<a id="lifecycle"></a>

## 8. 終了・再起動・更新・削除

| 操作 | 方法 |
| --- | --- |
| 終了 | 黒いウィンドウを閉じます（または Ctrl+C）。入力内容はその都度 PC に保存されています。 |
| 再起動 | もう一度 `start.cmd`（`start.command` / `start.sh`）を開きます。起動中にもう一度開くと、起動中の画面をブラウザーで開きます。 |
| 更新 | 新しい版の zip を手順 1〜4 と同じように展開して起動します。**データは引き継がれます**（展開フォルダーとは別の場所に保存しているため）。古い版のフォルダーは削除してかまいません。 |
| 削除 | 展開したフォルダーと、下表のデータの保存先フォルダーを削除します。レジストリやシステム フォルダーには何も書き込んでいません。 |

### データの保存先

| OS | 場所 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\BusinessAnalyticsStudio` |
| macOS | `~/Library/Application Support/BusinessAnalyticsStudio` |
| Linux | `~/.local/share/BusinessAnalyticsStudio` |

**バックアップ:** BAS を終了してから、このフォルダーをコピーします。アプリ内の［全量エクスポート］でも、データを 1 つのファイルに書き出せます。<br>
**別の場所に保存したいとき:** `start.cmd --data-dir D:\BAS-data` のように指定します。

<a id="trouble"></a>

## 9. うまくいかないとき

| 症状 | 対処 |
| --- | --- |
| `start.cmd` を開くと「Windows によって PC が保護されました」 | ［詳細情報］→［実行］。次回から表示しないようにするには、zip を削除し、[手順 3](#extract) のブロック解除をしてから展開し直します。 |
| 黒いウィンドウがすぐ閉じる | `start.cmd` をコマンド プロンプトから実行して、表示されるメッセージ（「起動できませんでした / Could not start: …」）を確認します。zip の中から直接開いていないかも確認してください。 |
| 「このアプリは PC 上で実行できません」 | 別の種類の PC 向け zip です。[手順 1](#download) の表で正しい zip を選び直します。 |
| 「このプログラムはグループ ポリシーによってブロックされています」 | 会社のポリシー（AppLocker など）による制限です。[IT 部門の方へ](#it) を IT 部門にお渡しください。 |
| ブラウザーが開かない | 黒いウィンドウに表示されたアドレスをブラウザーに入力します。 |
| ポートが使用中 | 4300〜4309 の空いているポートを自動で使います。すべて使用中なら `start.cmd --port 4400` のように指定します。 |
| 画面に「中継プロセスに接続できません」 | 黒いウィンドウが閉じていないか確認し、閉じていれば `start.cmd` を開き直します。 |
| ［ネットワークを確認］で「接続不可」 | 会社のプロキシが自動で検出できていない可能性があります。展開したフォルダーの `network.example.json` を `network.json` にリネームし、`"proxy"` に IT 部門から聞いたプロキシの URL（例: `"http://proxy.example.com:8080"`）を書いて、BAS を起動し直します。 |
| 「証明書」に関するエラー | 会社の TLS 検査用ルート証明書が OS に入っていない可能性があります。IT 部門に確認してください（BAS は既定で OS の証明書ストアを信頼します）。 |
| Copilot で「サインインしていません」 | [5-B](#ai) の手順で `copilot` を起動し `/login` してから、［サインイン状態とモデルを確認］を押し直します。 |
| Entra ID でサインインできない | アカウントに Foundry リソースへのアクセス権があるか、組織の条件付きアクセスで許可されているかを IT 部門に確認します。 |
| macOS で「開発元を検証できない」 | [手順 4](#start) の macOS の手順を行います。 |
| オプションの一覧を見たい | `start.cmd --help` |

<a id="it"></a>

## 10. IT 部門の方へ

### 構成と動作

- zip には、公式配布の Node.js ランタイム（`runtime/`）、アプリ本体（`app/`）、ローカル サーバー（`server/`）が含まれます。インストーラー、サービス登録、レジストリ変更、管理者権限は使いません。
- ローカル サーバーは **127.0.0.1 のみ**で待ち受けます（既定 4300〜4309）。ほかの PC からは接続できません。
- 業務データは利用者の PC の「データの保存先」（[8 章](#lifecycle)）にのみ保存します。API キーやトークンなどの秘密情報は、同じフォルダーに OS の保護機能（Windows は DPAPI）で暗号化して保存します。
- AI への送信は、利用者が［AI 設定］で設定した**お客様の** Microsoft Foundry / GitHub Copilot に対してのみ行います。開発元のサーバーへは何も送信しません。
- AppLocker / WDAC でユーザー フォルダーの実行を制限している場合は、展開先の `runtime\node.exe`（macOS / Linux は `runtime/bin/node`）と `start.cmd` の許可が必要です。ハッシュ規則を使う場合は、版ごとに更新してください。

### 通信先（許可リスト用）

| 用途 | 接続先（HTTPS 443） |
| --- | --- |
| ダウンロード | `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`, `dahatake.github.io`, `api.github.com` |
| Microsoft Foundry（Entra ID） | `login.microsoftonline.com`, `management.azure.com`, お客様の Foundry エンドポイント（`*.services.ai.azure.com`, `*.openai.azure.com`, `*.cognitiveservices.azure.com`） |
| GitHub Copilot | `api.githubcopilot.com`, `*.githubcopilot.com`, `api.github.com`, `github.com` |
| Work IQ（Microsoft 365、任意） | Microsoft 365 / Microsoft Graph の接続先、`registry.npmjs.org`（初回の CLI 取得） |

### プロキシと証明書

- 既定では OS のプロキシ設定（Windows のインターネット オプション、PAC / WPAD を含む）と、OS の証明書ストア（社内ルート CA を含む）を使います。
- 一括で設定を配布する場合は、展開フォルダー（`start.cmd` と同じ場所）またはデータの保存先に `network.json` を置きます。

  ```json
  {
    "proxy": "http://proxy.example.com:8080",
    "pacUrl": "http://proxy.example.com/proxy.pac",
    "noProxy": ["*.internal.example.com", "10.0.0.0/8"],
    "systemCa": true
  }
  ```

  `"proxy"` には `"system"`（既定）・`"direct"`・`"auto"`・プロキシ URL（`http://user:pass@host:port`、`socks5://host:port` も可）を指定できます。環境変数 `BAS_PROXY` / `BAS_PAC_URL` / `BAS_NO_PROXY` / `BAS_SYSTEM_CA` は `network.json` より優先されます。
- **NTLM / Kerberos 認証のみを受け付けるプロキシには対応していません。** 上表の接続先を認証不要の許可リストに加えるか、基本認証のプロキシ URL を指定してください。

### 配布物の確認

- 各 zip の SHA-256 は Release の `SHA256SUMS.txt` と Release ノートに記載しています。
- zip は GitHub Actions でこのリポジトリーのソースから作成し、`gh attestation verify <zip> --repo dahatake/Business-Analytics-Studio` で作成元を検証できます。
- zip 内の各ファイルのハッシュは、展開フォルダーの `SHA256SUMS.txt` にあります。
