# 顧客パック作成プロンプト（Microsoft 365 Copilot 用） / Customer pack prompt for Microsoft 365 Copilot

このファイルは、社内の資料（Excel・PowerPoint・Word・PDF・メール・会議の記録など）から、Business Analytics Studio（BAS）の**顧客パック**を Microsoft 365 Copilot に作らせるためのプロンプトです。アプリの「データ管理」画面にも同じ内容が表示され、コピー・ダウンロードできます（この Markdown が唯一の原本で、アプリはビルド時にここから読み込みます）。

This file holds the prompt that lets Microsoft 365 Copilot turn your files (Excel, PowerPoint, Word, PDF, mail, meeting notes) into a Business Analytics Studio (BAS) **customer pack**. The app's "Data management" screen shows, copies and downloads the same text (this Markdown is the single source; the app bundles it at build time).

## 使い方 / How to use

1. Microsoft 365 Copilot Chat（職場向け）を開き、新しいチャットを始めます。 / Open Microsoft 365 Copilot Chat (work) and start a new chat.
2. 下のプロンプトを貼り付け、`{{ }}` の部分を書き換えます。資料は `/` を入力してファイル・メール・会議を選ぶか、ファイルを添付します。 / Paste the prompt below and replace the `{{ }}` parts. Reference files, mail and meetings by typing `/`, or attach files.
3. Copilot は「資料の一覧」→「PART 1/N」の順に出力します。続きは「続けて」と送ります。 / Copilot answers with the source inventory, then PART 1/N. Send "continue" for the next part.
4. すべての回答をコピーして（または .txt / .json に保存して）、BAS の「データ管理」画面の取り込み欄に貼り付け・アップロードし、「検査する」を押します。 / Copy every answer (or save them as .txt / .json), paste or upload them on the BAS "Data management" screen and press "Check".
5. 問題が出たら、BAS が作る「修正用プロンプト」をコピーし、同じチャットに送ります。直った回答で 4 をやり直します。 / If problems are reported, copy the "fix prompt" BAS generates, send it in the same chat and repeat step 4 with the corrected answer.

取り込む前に、データの所有者に利用を承認してもらってください。BAS は取り込んだデータを外部に送りません（ブラウザー内の、この端末の保存領域だけに置きます）。

Get the data owner's approval before importing. BAS never sends the imported data anywhere (it stays in this browser's storage on this device).

<!-- prompt:ja:start -->
あなたは業務分析のデータエンジニアです。私が指定する資料だけを根拠に、Business Analytics Studio（BAS）が読み込む「顧客パック」の JSON を作ってください。

# 対象
- 企業: {{企業名}}
- Project: {{Project 名}}（目的: {{業務改善の目的}}）
- 資料: {{ここで / を入力して、ファイル・メール・会議・チャットを参照する}}

# 進め方（この順で行う）
1. 資料の一覧: 参照した資料ごとに 1 行の表（資料名 / 種類 / 発行者 / 発行日または更新日 / 含まれる情報 / 社外秘か）を出す。読めなかった資料は「読めない」と書く。
2. 事実の抽出: 資料に書かれている事実だけを、下の kind に当てはめる。資料にない値は作らない（推測・一般論・業界平均で埋めない）。必須の項目が資料から決まらないエンティティは出力しない。
3. JSON の出力: 下の「出力形式」で出す。

# 出力形式
- 各 PART は ```json のコードブロック 1 つだけ。1 回の回答に入れるエンティティは 40 件まで。続きがあれば回答の最後に「続きは『続けて』と送ってください（PART k/N）」と書く。
- PART 1 だけがパック全体の項目を持つ:
  {"part":"1/N","packId":"英小文字とハイフン","company":{"name":{"ja":"","en":""},"industry":{"ja":"","en":""}},"isSample":false,"regions":[{"id":"region-...","name":{"ja":"","en":""}}],"flows":[],"entities":[ まず source をすべて ]}
- PART 2 以降: {"part":"k/N","entities":[ ... ]}
- flows（物の流れ）: {"source":"id","target":"id","valueT":月間トン}。資料に物量があるときだけ。
- optimization（工場から地域への配分の最適化）: 資料に工場ごとの能力・地域ごとの需要・生産費・輸送費・CO2・リードタイム・現在の配分がすべてそろうときだけ PART 1 に入れる。1 つでも欠けるなら項目ごと省く。形: {"period":表示文,"plants":[{"siteId","capacityT","productionCostPerT","co2PerT"}],"regionDemandT":[地域順],"transportCostPerT":[[工場×地域]],"leadTimeDays":[[工場×地域]],"co2TransportPerT":[[工場×地域]],"currentAllocation":[[工場×地域]]}

# すべてのエンティティに共通の項目（必須）
id, kind, name, description, world, type, classification, author, sourceIds
- 表示文（name・description など）は必ず {"ja":"日本語","en":"English"} の両方。
- id は「英小文字の接頭辞-英小文字・数字・ハイフン」（例: site-tokyo, kpi-otd-rate）。パックの中で一意にする。参照する項目には、このパックに出した id だけを書く。
- sourceIds: 根拠になった source の id。数値を持つ kind（site, product, deal, invoice, issue, solution, kpi, initiative）は 1 件以上必須。根拠のない数値は出さない。
- classification: 社外に見せてよい情報だけ "shareable"。それ以外と迷うものは "internal"。
- author: "ai"
- 日付は YYYY-MM-DD。金額は円の数値（カンマや単位を付けない）。

# kind ごとの項目（world/type はこの値をそのまま書く）
- source（資料そのもの。digital/data）: publisher（表示文）, publishedDate
- site（拠点。real/site）: role は "hq"・"plant"・"dc" のどれか, lat, lon, capacityTPerMonth（月間トン。本社など生産しない拠点は 0）
- person（real/person）: role（役職の表示文）, siteId。業務上の役割として資料に出る人だけ。年齢・性別・似顔絵の項目（ageBand, gender, portrait）は書かない。
- customer（顧客企業。real/organization）: industry（表示文）, regionId
- product（製品。real/thing）: category（表示文）, siteId, unitPriceJpy
- deal（案件。real/event）: customerId, productIds（1 件以上）, ownerId（person）, stage は "lead"・"proposal"・"negotiation"・"won"・"delivered", valueJpy, closeDate
- deliverable（納品物。real/thing）: dealId, dueDate, status は "planned"・"inProgress"・"done"
- invoice（請求。digital/data）: deliverableId, amountJpy, issuedDate, status は "draft"・"sent"・"paid"・"overdue"
- issue（課題。real/event）: impact（1〜5）, feasibility（1〜5）, causeIds（cause）, kpiIds（kpi）
- cause（原因。real/event）: 共通の項目だけ
- solution（解決策。digital/system）: issueIds（1 件以上）, kpiIds, msProducts（製品名の文字列の配列。なければ []）, costJpy, annualBenefitJpy
- kpi（digital/metric）: unit（表示文）, baseline, current, target, direction は "increase"・"decrease", scale は "ratio"（0 に意味がある量）・"interval"（それ以外）, period（表示文）, ownerId（person）
- initiative（施策。real/operation）: solutionId, start, end, progress（0〜1）, dependsOn（initiative の id。なければ []）, ownerId（person）
- supplier（仕入先。real/organization）: regionId
- 顧客・製品の絵の項目（illustration）は書かない（BAS が飾りの絵を付ける）。

# 出力の前に自分で確かめること
- すべての id が一意で、参照先の id がパックの中にあり、種類が合っている（ownerId は person、siteId は site など）。
- 数値を持つエンティティすべてに sourceIds がある。
- 資料にない値・人物の私的な情報を書いていない。
- JSON として正しい（コメント・末尾のカンマなし）。
<!-- prompt:ja:end -->

<!-- prompt:en:start -->
You are a data engineer for business analysis. Using only the sources I give you, build the "customer pack" JSON that Business Analytics Studio (BAS) loads.

# Scope
- Company: {{company name}}
- Project: {{project name}} (goal: {{business improvement goal}})
- Sources: {{type / here to reference files, mail, meetings and chats}}

# Steps (in this order)
1. Source inventory: one table row per source (title / type / publisher / published or updated date / information it holds / confidential or not). Mark sources you could not read as "unreadable".
2. Extract facts: map only facts written in the sources to the kinds below. Never invent values (no guesses, generic knowledge or industry averages). Skip an entity when a required field cannot be taken from the sources.
3. Output the JSON in the format below.

# Output format
- Each PART is exactly one ```json code block, with at most 40 entities per answer. If more follows, end the answer with "Send 'continue' for the next part (PART k/N)".
- Only PART 1 holds the pack-level fields:
  {"part":"1/N","packId":"lowercase-and-hyphens","company":{"name":{"ja":"","en":""},"industry":{"ja":"","en":""}},"isSample":false,"regions":[{"id":"region-...","name":{"ja":"","en":""}}],"flows":[],"entities":[ all source entities first ]}
- PART 2 onwards: {"part":"k/N","entities":[ ... ]}
- flows (material flow): {"source":"id","target":"id","valueT":tonnes per month}, only when the sources give volumes.
- optimization (allocating plant supply to regions): include it in PART 1 only when the sources give every one of plant capacity, regional demand, production cost, transport cost, CO2, lead time and the current allocation. If anything is missing, leave the whole field out. Shape: {"period":text,"plants":[{"siteId","capacityT","productionCostPerT","co2PerT"}],"regionDemandT":[by region],"transportCostPerT":[[plant×region]],"leadTimeDays":[[plant×region]],"co2TransportPerT":[[plant×region]],"currentAllocation":[[plant×region]]}

# Fields every entity has (required)
id, kind, name, description, world, type, classification, author, sourceIds
- Display text (name, description, …) is always {"ja":"Japanese","en":"English"}, both filled.
- id is "lowercase prefix-lowercase letters, digits, hyphens" (e.g. site-tokyo, kpi-otd-rate), unique in the pack. References use only ids present in this pack.
- sourceIds: ids of the source entities backing the item. Required (at least one) for kinds with numbers (site, product, deal, invoice, issue, solution, kpi, initiative). Do not output numbers without a source.
- classification: "shareable" only for information the customer may show outside; everything else, and anything unsure, is "internal".
- author: "ai"
- Dates are YYYY-MM-DD. Amounts are plain yen numbers (no commas or units).

# Fields per kind (write world/type exactly as given)
- source (the document itself; digital/data): publisher (text), publishedDate
- site (real/site): role is "hq", "plant" or "dc", lat, lon, capacityTPerMonth (tonnes per month; 0 for sites that do not produce)
- person (real/person): role (job title text), siteId. Only people named in the sources in a business role. Do not write age, gender or portrait fields (ageBand, gender, portrait).
- customer (real/organization): industry (text), regionId
- product (real/thing): category (text), siteId, unitPriceJpy
- deal (real/event): customerId, productIds (at least one), ownerId (person), stage is "lead", "proposal", "negotiation", "won" or "delivered", valueJpy, closeDate
- deliverable (real/thing): dealId, dueDate, status is "planned", "inProgress" or "done"
- invoice (digital/data): deliverableId, amountJpy, issuedDate, status is "draft", "sent", "paid" or "overdue"
- issue (real/event): impact (1–5), feasibility (1–5), causeIds (cause), kpiIds (kpi)
- cause (real/event): the common fields only
- solution (digital/system): issueIds (at least one), kpiIds, msProducts (array of product-name strings, [] if none), costJpy, annualBenefitJpy
- kpi (digital/metric): unit (text), baseline, current, target, direction is "increase" or "decrease", scale is "ratio" (zero means none) or "interval" (otherwise), period (text), ownerId (person)
- initiative (real/operation): solutionId, start, end, progress (0–1), dependsOn (initiative ids, [] if none), ownerId (person)
- supplier (real/organization): regionId
- Do not write the picture field of customers and products (illustration); BAS adds a decorative one.

# Check before you answer
- Every id is unique; every reference points to an id in this pack of the right kind (ownerId → person, siteId → site, …).
- Every entity with numbers has sourceIds.
- No invented values and no private details about people.
- Valid JSON (no comments, no trailing commas).
<!-- prompt:en:end -->
