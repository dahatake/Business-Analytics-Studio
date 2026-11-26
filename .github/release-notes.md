Business Analytics Studio {{VERSION}} のポータブル版です。インストールと管理者権限は不要です。zip を展開して起動ファイルを開くだけで使えます。

**はじめての方は、画面付きの手順書をご覧ください: {{PAGES}}/guide.html**
（ダウンロード ページ: {{PAGES}}/ ）

## ダウンロードするファイル

| お使いの PC | ファイル名の末尾 | 起動ファイル |
|---|---|---|
| Windows 10/11（Intel・AMD、ほとんどの PC） | `-win-x64.zip` | `start.cmd` |
| Windows 11（Arm。Snapdragon など） | `-win-arm64.zip` | `start.cmd` |
| Mac（Apple シリコン。M1 以降） | `-mac-arm64.zip` | `start.command` |
| Mac（Intel） | `-mac-x64.zip` | `start.command` |
| Linux（x64） | `-linux-x64.zip` | `start.sh` |
| Linux（Arm64） | `-linux-arm64.zip` | `start.sh` |

## ダウンロードしたファイルの確認（推奨）

各 zip の SHA-256 は下記と `SHA256SUMS.txt` にあります。Windows の場合は PowerShell で確認します。

```powershell
Get-FileHash .\BusinessAnalyticsStudio-*-win-x64.zip -Algorithm SHA256
```

GitHub CLI がある場合は、このリポジトリの GitHub Actions でビルドされたことも確認できます。

```text
gh attestation verify <zip ファイル> --repo {{REPO}}
```

## 主な注意

- AI（Microsoft Foundry・GitHub Copilot・Work IQ）は、お客様ご自身のアカウントとリソースを使います。
- プロキシと社内の証明書は OS の設定を自動で使います。［設定］→［AI］→［ネットワークを確認］で到達を確認できます。
- データは展開したフォルダーとは別の場所に保存されます。新しい版の zip に差し替えてもデータは残ります。

## SHA-256
