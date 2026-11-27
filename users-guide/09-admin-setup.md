# 第9章 管理者向け：AzureとGitHub Copilotの準備・社内ユーザーの追加

この章は、BAS の利用者が組織の生成AIを使えるようにする**管理者**向けです。Microsoft Foundry（Azure）を使う場合は、Foundry リソースとモデルを用意し、BAS 利用者の Microsoft Entra セキュリティグループに、そのリソースだけを呼び出す役割を付けます。以後の社内ユーザーの追加・削除は、**グループのメンバーを増減するだけ**です。GitHub Copilot を使う場合は、GitHub の組織で利用者にシートを割り当てます。

利用者の PC での作業は[第1章](01-setup.md)にあります。作業は同じ `setup.ps1` で行い、管理者用のオプション（`-AzureAdmin`、`-AddUser`、`-RemoveUser`）を付けます。

**前:** [第8章 会議モードとバックアップ](08-meetings-and-backup.md)

**目次:** [ユーザーガイド目次](README.md)

## 作られるものと考え方

```text
Azure サブスクリプション
└─ リソースグループ（例: rg-bas）
   └─ Microsoft Foundry リソース（種類 AIServices、独自サブドメイン付き。例: bas-contoso）
      ├─ モデルのデプロイ（既定: gpt-6.2-sol）
      └─ アクセス制御 (IAM)
         └─ 「Cognitive Services OpenAI User」 → Microsoft Entra セキュリティグループ「BAS Users」
                                                    ├─ 利用者 A
                                                    └─ 利用者 B   ← ユーザーの追加・削除はここだけ
```

- 役割は**グループ**に、**その Foundry リソースだけ**を対象（スコープ）に付けます。リソースグループやサブスクリプションには付けません。個人に直接付けないので、異動・退職時はグループから外すだけで呼び出せなくなります（[最小特権のための推奨事項（Microsoft Learn）](https://learn.microsoft.com/azure/role-based-access-control/best-practices)）。
- BAS は利用者本人の Microsoft Entra ID でサインインして呼び出します。共有の API キーは配りません。キーを無効にすると（`-DisableKeys`）、Entra ID 以外では呼び出せなくなります。
- 「所有者」や「共同作成者」はリソースを管理する役割で、**モデルを呼び出す権限（データ アクション）を含みません**。管理者自身が BAS を使う場合も、グループに入るか、BAS の **自分にロールを付与** で役割を付けてください（[Microsoft Foundry のロールベースのアクセス制御（Microsoft Learn）](https://learn.microsoft.com/azure/foundry/concepts/rbac-foundry)）。
- 利用者の PC に Azure CLI は不要です。BAS は Azure CLI と同じ公開クライアント（アプリ ID `04b07795-8ddb-461a-bbee-02f9e1bf7b46`）でサインインするので、アプリの登録や管理者の同意は不要です。条件付きアクセスでこのクライアントを制限している場合は、利用者を許可してください。

## 必要な権限

作業を1人で行う場合は、次のすべてが必要です。分担する場合は、各担当者に依頼してください。

| 作業 | 必要な役割（いずれか） | 対象 |
|---|---|---|
| リソースグループの作成 | 共同作成者、所有者 | サブスクリプション |
| Foundry リソース・デプロイの作成、キーの無効化 | Cognitive Services 共同作成者（Cognitive Services Contributor）、共同作成者、所有者 | リソースグループ |
| 役割の割り当て | 所有者、ユーザー アクセス管理者（User Access Administrator）、ロールベースのアクセス制御管理者（Role Based Access Control Administrator） | Foundry リソース（またはリソースグループ） |
| セキュリティグループの作成 | 一般ユーザーに作成が許されていない組織では、グループ管理者（Groups Administrator） | Microsoft Entra ID |
| メンバーの追加・削除 | グループの所有者（スクリプトは作成者を所有者にします）、グループ管理者、ユーザー管理者 | そのグループ |
| GitHub Copilot のシート割り当て・ポリシー | 組織の所有者（Organization owner） | GitHub の組織 |

参考: [Azure 組み込みロール（Microsoft Learn）](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles)、[Microsoft Entra の組み込みロール（Microsoft Learn）](https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference)

## 1. 事前準備（管理者の PC）

1. Azure CLI をインストールし、ターミナルを開き直します（[Windows に Azure CLI をインストールする（Microsoft Learn）](https://learn.microsoft.com/cli/azure/install-azure-cli-windows)）。

   ```powershell
   winget install --exact --id Microsoft.AzureCLI
   ```

2. BAS 利用者がいるテナントにサインインし、使うサブスクリプションを確認します。

   ```powershell
   az login --tenant <テナント ID>
   az account show -o table
   ```

   別のサブスクリプションを使う場合は、スクリプトに `-SubscriptionId <ID または名前>` を付けます。

3. BAS 一式を用意します。管理者モードでは Node.js や依存関係は入れないので、`setup.ps1` があれば実行できます。

## 2. スクリプトで準備する（推奨）

最初に必ず `-DryRun` を付けて、何が作られるかを確認します。`-DryRun` は Azure と Microsoft Entra ID を一切変更せず、実行する `az` コマンドを表示します。

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -AzureAdmin -ResourceGroup rg-bas -Location japaneast -AccountName bas-contoso -DryRun
```

内容を確認したら `-DryRun` を外して実行します。変更のたびに確認（Y/N）を求めます。最初の利用者も同時に追加できます。

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -AzureAdmin -ResourceGroup rg-bas -Location japaneast -AccountName bas-contoso -DisableKeys -AddUser a@contoso.com,b@contoso.com
```

スクリプトは次を順に行います。すでにあるものはそのまま使い（`exists` と表示）、作り直しません。途中で止まっても、同じコマンドをもう一度実行すれば続きから進みます。

| 順 | 内容 | 主な表示 |
|---|---|---|
| 1 | リソースグループの確認・作成 | `Resource group rg-bas exists` |
| 2 | Foundry リソース（種類 AIServices、価格レベル S0、独自サブドメイン = `-AccountName`）の確認・作成 | `Microsoft Foundry resource bas-contoso exists` |
| 3 | `-DisableKeys` のとき API キーを無効化（`disableLocalAuth=true`） | `Disabling API keys` |
| 4 | クォータ（割り当て量）の確認と、モデルのデプロイの作成 | `Quota OpenAI.GlobalStandard.gpt-6.2-sol in japaneast: … (free …)` |
| 5 | セキュリティグループの確認・作成（作成した人を所有者にする） | `Microsoft Entra group 'BAS Users' exists` |
| 6 | グループに、このリソースだけを対象に役割を割り当て | `Assigned 'Cognitive Services OpenAI User' to the group on bas-contoso` |
| 7 | `-AddUser` ／ `-RemoveUser` のメンバー変更 | `Adding … to 'BAS Users'` |
| 8 | 利用者に伝える内容 | `Tell BAS users:` |

最後に表示される **Tell BAS users** の内容（テナント ID、Foundry リソース名、エンドポイント、デプロイ名）を利用者に伝えてください。利用者はこれを見て[第1章](01-setup.md#microsoft-foundry-を使う)の手順で接続します。

### 主なオプション

| オプション | 既定値 | 説明 |
|---|---|---|
| `-ResourceGroup` | （必須） | リソースグループ名 |
| `-AccountName` | （必須） | Foundry リソース名。`https://<名前>.openai.azure.com` になるので Azure 全体で一意な 3〜64 文字の英数字とハイフン |
| `-Location` | `japaneast` | 作成するリージョン |
| `-SubscriptionId` | 現在のサブスクリプション | 使うサブスクリプション |
| `-GroupName` | `BAS Users` | セキュリティグループの表示名（テナント内で一意にしてください） |
| `-DeploymentName` ／ `-ModelName` ／ `-ModelVersion` | `gpt-6.2-sol` ／ `gpt-6.2-sol` ／ `2026-11-17` | デプロイするモデル |
| `-ModelSku` | `GlobalStandard` | デプロイの種類。データの処理場所を限定するなら `DataZoneStandard` など（[デプロイの種類（Microsoft Learn）](https://learn.microsoft.com/azure/foundry/foundry-models/concepts/deployment-types)） |
| `-Capacity` | 空いているクォータすべて | デプロイの容量（1 = 1,000 トークン／分） |
| `-ExtraRoles` | なし | 追加の役割。`Speech`（音声）、`Vision`（画像）、`Decision`（Decision モデル）をカンマ区切りで |
| `-DisableKeys` | 無効にしない | API キーを無効にし、Microsoft Entra ID だけにする（推奨） |
| `-AddUser` ／ `-RemoveUser` | なし | メンバーの追加・削除。UPN、メールアドレス、オブジェクト ID をカンマ区切りで |
| `-DryRun` | — | 何も変更せず、実行するコマンドだけを表示 |
| `-Yes` | — | 確認（Y/N）を省略（手順書化・自動化用。先に `-DryRun` で確認してください） |

### 割り当てる役割

| BAS の機能 | 役割（Azure ポータルの表示名） | 必須 | スクリプト |
|---|---|---|---|
| 生成AI（Projectパックの作成、ドラフトなど） | Cognitive Services OpenAI User | ○ | 常に割り当て |
| 音声（Speech） | Cognitive Services Speech User | 使う場合 | `-ExtraRoles Speech` |
| 画像（Vision） | Cognitive Services User | 使う場合 | `-ExtraRoles Vision` |
| Decision モデル | Foundry User（旧 Azure AI User） | 使う場合 | `-ExtraRoles Decision` |

## 3. 社内ユーザーを追加・削除する

以後の追加・削除は、グループのメンバーを変えるだけです。Azure の役割には触れません。グループの所有者であれば、サブスクリプションの権限は読み取りだけで足ります。

**スクリプトで（推奨）:**

```powershell
# 追加（複数はカンマ区切り）
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -ResourceGroup rg-bas -AccountName bas-contoso -AddUser c@contoso.com,d@contoso.com
# 削除
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -ResourceGroup rg-bas -AccountName bas-contoso -RemoveUser a@contoso.com
```

`-GroupName` を既定以外で作った場合は、同じ名前を付けます。ユーザーはまず UPN で探し、見つからなければメールアドレスで探します（ゲストユーザーの UPN は `name_contoso.com#EXT#@…` のようになるため）。社外のユーザーは、先にテナントへゲストとして招待してください（[B2B コラボレーション ユーザーを追加する（Microsoft Learn）](https://learn.microsoft.com/entra/external-id/add-users-administrator)）。

**Microsoft Entra 管理センターで:** **Entra ID** → **グループ** → **すべてのグループ** → 「BAS Users」 → **メンバー** → **メンバーの追加**（[グループとメンバーシップを管理する（Microsoft Learn）](https://learn.microsoft.com/entra/fundamentals/how-to-manage-groups)）。

**Azure CLI で:**

```powershell
az ad group member add --group "BAS Users" --member-id (az ad user show --id c@contoso.com --query id -o tsv)
az ad group member remove --group "BAS Users" --member-id (az ad user show --id a@contoso.com --query id -o tsv)
```

**反映までの時間:** 役割の割り当ての変更は最大10分、グループのメンバー変更は利用者のアクセストークンが更新されたとき（サインインし直す、または約1時間後）に反映されます。追加した利用者には「BAS の AI 設定でサインアウトしてサインインし直す」よう伝えてください。削除した利用者も、トークンの有効期限（約1時間）までは呼び出せる場合があります（[ロールの割り当ての変更が反映されない（Microsoft Learn）](https://learn.microsoft.com/azure/role-based-access-control/troubleshooting#symptom---role-assignment-changes-are-not-being-detected)）。

**確認:** 利用者本人が、[第1章の権限の事前確認](01-setup.md#microsoft-foundry-を使う)（`setup.ps1 -Ai Foundry -ResourceGroup … -AccountName …`）を実行すると、`OK  Chat` になります。管理者側では、Azure ポータルのリソースの **アクセス制御 (IAM)** → **アクセスの確認** で、利用者を検索して役割を確認できます（[1人のユーザーのアクセスを確認する（Microsoft Learn）](https://learn.microsoft.com/azure/role-based-access-control/check-access)）。

## 4. スクリプトを使わない場合（Azure ポータル）

組織の手順でポータルを使う場合は、次の順に行います。結果はスクリプトと同じです。

1. **リソースグループを作る**: Azure ポータル → **リソース グループ** → **作成**（[リソースグループを管理する（Microsoft Learn）](https://learn.microsoft.com/azure/azure-resource-manager/management/manage-resource-groups-portal)）。
2. **Foundry リソースを作る**: Azure ポータル → **Microsoft Foundry** → **作成**。リソースグループ・リージョン・名前を指定します。名前が独自サブドメインになります（[Microsoft Foundry リソースを作成する（Microsoft Learn）](https://learn.microsoft.com/azure/foundry/how-to/create-resource-template)）。
3. **モデルをデプロイする**: Foundry ポータル（[ai.azure.com](https://ai.azure.com)）でリソースを開き、**モデル + エンドポイント** → **モデルのデプロイ** で `gpt-6.2-sol` を選びます。デプロイ名を控えておきます（[モデルをデプロイする（Microsoft Learn）](https://learn.microsoft.com/azure/foundry/foundry-models/how-to/deploy-foundry-models)）。
4. **API キーを無効にする（推奨）**: Azure CLI で `az resource update --ids <リソース ID> --set properties.disableLocalAuth=true`（[ローカル認証を無効にする（Microsoft Learn）](https://learn.microsoft.com/azure/ai-services/disable-local-auth)）。
5. **セキュリティグループを作る**: Microsoft Entra 管理センター → **グループ** → **新しいグループ**。種類は **セキュリティ**、メンバーシップは **割り当て済み** にし、自分を所有者にします（[グループを作成する（Microsoft Learn）](https://learn.microsoft.com/entra/fundamentals/how-to-manage-groups#create-a-basic-group-and-add-members)）。
6. **役割を割り当てる**: Azure ポータルで **Foundry リソース**（リソースグループではありません）を開き、**アクセス制御 (IAM)** → **追加** → **ロールの割り当ての追加** → 「Cognitive Services OpenAI User」 → **メンバー** で「ユーザー、グループ、またはサービス プリンシパル」→ 作ったグループ → **レビューと割り当て**（[Azure ポータルで Azure ロールを割り当てる（Microsoft Learn）](https://learn.microsoft.com/azure/role-based-access-control/role-assignments-portal)）。
7. **利用者を追加する**: 上の「3. 社内ユーザーを追加・削除する」。

## 5. クォータと費用

- Foundry リソース自体に固定費はありません。モデルの呼び出しが、トークン数に応じてこのサブスクリプションに課金されます。BAS は金額を計算・制限しません。予算とアラートは Azure 側で設定してください（[予算を作成する（Microsoft Learn）](https://learn.microsoft.com/azure/cost-management-billing/costs/tutorial-acm-create-budgets)）。
- クォータ（1分あたりのトークン数）は**サブスクリプション・リージョン・モデル・デプロイの種類ごと**に共有されます。スクリプトが `No free quota is left` で止まった場合は、既存デプロイの容量を下げる、別の `-Location` や `-ModelSku` を使う、または [クォータの引き上げを申請](https://aka.ms/oai/stuquotarequest) します（[クォータを管理する（Microsoft Learn）](https://learn.microsoft.com/azure/foundry/openai/how-to/quota)）。
- 利用者が増えて `429`（要求が多すぎる）が出る場合は、デプロイの容量を増やします。

## 6. GitHub Copilot を組織で使えるようにする

GitHub Copilot を選ぶ利用者には、Azure の準備は不要です。代わりに、GitHub の組織の所有者が次を行います。

1. **シートを割り当てる**: 組織の **Settings** → **Copilot** → **Access** で、利用者（またはチーム）にシートを割り当てます（[組織のメンバーに Copilot へのアクセスを付与する（GitHub Docs）](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/manage-access/grant-access)）。
2. **Copilot CLI を有効にする**: 組織の **Settings** → **Copilot** → **Policies** で **Copilot CLI** を有効にし、使わせるモデルを有効にします。BAS は Copilot CLI と同じ仕組み（Copilot SDK）で呼び出すため、これが無効だと利用者の確認が「使えるモデルがありません」になります（[組織の Copilot のポリシーを管理する（GitHub Docs）](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/manage-policies)）。
3. 利用者は[第1章](01-setup.md#github-copilot-を使う)の手順で `npx -y @github/copilot login` を実行し、`node scripts/bas.ts copilot check` で確かめます。

シートを外すと、利用者はその請求期間の終わりまで使える場合があります。BAS からの呼び出しは、各利用者の Copilot の契約（プレミアム リクエストなど）に従って数えられます。

## 確認と困ったとき

| 症状 | 原因 | 次にすること |
|---|---|---|
| `Azure CLI is not signed in.` | `az login` をしていない | `az login --tenant <テナント ID>` |
| `cannot be a custom subdomain` ／ リソースの作成に失敗 | 名前の形式、または名前がすでに使われている | 別の `-AccountName` を指定 |
| `has no custom subdomain` | 既存のリソースに独自サブドメインがない | 新しい `-AccountName` で作る（BAS の Entra ID 接続には独自サブドメインが必須） |
| `No free quota is left` ／ `more than the free quota` | クォータ不足 | 上の「5. クォータと費用」 |
| グループの作成に失敗 | テナントでグループ作成が制限されている | グループ管理者にグループを作ってもらい、`-GroupName` で指定 |
| `Assigning … failed` | 役割を割り当てる権限がない | 所有者・ユーザー アクセス管理者・ロールベースのアクセス制御管理者に依頼 |
| `The new group is not visible to Azure RBAC yet` | 新しいグループの複製待ち | 数分待って同じコマンドを再実行（完了済みの手順は省略されます） |
| `User … was not found in this tenant` | UPN／メールの誤り、または未招待のゲスト | Entra 管理センターで UPN を確認するか、ゲストとして招待 |
| `More than one user has the e-mail address` | 同じメールのユーザーが複数 | UPN またはオブジェクト ID で指定 |
| 利用者が BAS で「モデル呼び出し権限なし」 | 反映待ち、またはグループ外 | 10分待ち、サインインし直してもらう。グループのメンバーと IAM の **アクセスの確認** を見る |
| 利用者の BAS にリソースが出ない | テナントが違う、リソースの種類が AIServices でない、独自サブドメインがない | 利用者に正しいテナント ID を伝える。リソースを確認 |

## 片付ける（BAS をやめるとき）

利用者全員がやめる場合は、リソースグループごと削除します。デプロイとリソースも消え、課金が止まります。削除したリソース名は、一定期間（論理的な削除）再利用できないことがあります（[論理的な削除と復元（Microsoft Learn）](https://learn.microsoft.com/azure/ai-services/recover-purge-resources)）。

```powershell
az group delete -n rg-bas
az ad group delete --group "BAS Users"
```

次は[ユーザーガイド目次](README.md)に戻るか、利用者向けの[第1章](01-setup.md)を確認してください。
