# 顧客パック作成プロンプト（Microsoft 365 Copilot 用） / Customer pack prompt for Microsoft 365 Copilot

このファイルは、**公開Webの調査**と**承認済みの社内資料の整形**を分けて、Business Analytics Studio（BAS）の顧客パックを Microsoft 365 Copilot に作らせるプロンプトです。アプリの「データ管理」画面から両方をコピーできます。この Markdown が唯一の原本です。

These prompts separate **public web research** from **approved internal material**, then assemble a BAS customer pack. Both are available in Data management. This Markdown is the single source.

## 使い方 / How to use

1. 最初に「公開Web調査」を、社内資料を添付しない新しいチャットで実行します。Webモードを選べる場合はWebを選択し、公開企業名・公式ドメインだけを使います。 / Run "Public web research" in a fresh chat without internal material; choose Web mode when available. Use only the public company name and domain.
2. 次に別の職場向けチャットで「顧客パック作成」を実行し、公開調査結果と承認済み資料を渡します。`{{ }}` を書き換え、利用可能なら `/` でファイル・メール・会議を参照するかファイルを添付します。社内検索はライセンス・権限・設定に依存します。 / In a separate work chat, run "Customer pack assembly" with the research results and approved files. Replace `{{ }}`; use `/` references if available, or attach files. Work grounding depends on licence, permissions and settings.
3. 資料一覧・不足一覧を確認した後、全PARTを取得します。続きは「続けて」と送ります。 / Review sources and gaps, then obtain every PART; send "continue" as needed.
4. すべての回答をコピーして（または .txt / .json に保存して）、BAS の「データ管理」画面の取り込み欄に貼り付け・アップロードし、「検査する」を押します。 / Copy every answer (or save them as .txt / .json), paste or upload them on the BAS "Data management" screen and press "Check".
5. 問題が出たら、BAS が作る「修正用プロンプト」をコピーし、同じチャットに送ります。直った回答で 4 をやり直します。 / If problems are reported, copy the "fix prompt" BAS generates, send it in the same chat and repeat step 4 with the corrected answer.

取り込む前に、データの所有者に利用を承認してもらってください。BAS は取り込んだデータを外部に送りません（ブラウザー内の、この端末の保存領域だけに置きます）。

Get the data owner's approval before importing. BAS never sends the imported data anywhere (it stays in this browser's storage on this device).

Web検索は管理者の **Allow web search in Copilot** と利用者のWeb設定に従います。プロンプトで無効設定を解除できません。検索ができない場合も失敗を明示し、知識や推測で代用しません。Copilotはプロンプトや参照資料からBing検索語を生成する場合があるため、公開調査を別チャットに分離します。引用URLはJSON内にも残します。BAS自体の自動外部調査は引き続き無効です。

Web search depends on admin **Allow web search in Copilot** and user controls; a prompt cannot override them. Mark blocked searches explicitly. Copilot may derive Bing queries from prompts or referenced material, so keep public research separate. Preserve citation URLs in JSON. BAS automated external research remains disabled.

公式根拠 / Official reference: [Microsoft: web search, privacy and controls](https://learn.microsoft.com/copilot/plan/manage-public-web-access).

## 公開Web調査 / Public web research

<!-- research:ja:start -->
公開情報のリサーチ担当として、次の企業をインターネットで調査してください。
- 公開企業名: {{公開されている正式企業名}}
- 公式ドメイン: {{公式ドメイン。不明なら同名企業を区別して特定}}
- 対象期間・基準日: {{対象期間と基準日}}
社内資料・メール・秘密のProject名・個人情報は使わず、公開企業名と公開ドメインだけを検索語に使ってください。Web検索が無効・利用不能なら「blocked」と理由を出し、調査したと偽らないでください。
優先順位は公式サイト > ブランドガイド > プレスキット > IR・有価証券報告書・統合報告書 > 公的機関 > 信頼できる報道。同名企業、親会社と子会社、連結と単体、対象年度、実績と目標を区別してください。
調査項目: 企業名・業種・事業、製品・拠点・公開座標、顧客・仕入先（取引を明記した出典のみ）、公開された役職、戦略・課題・KPI・施策・IT導入事例、ブランド色・フォント・ロゴ利用規則、公開データ辞書・用語・システム構成・関係・コアオブジェクト候補。
各事実に出典URL、発行者、発行日（不明はnull）、確認日、ページ・節、単位・期間・対象範囲を付けてください。検索結果の抜粋だけで断定せず本文を確認し、矛盾は両方を記録します。ロゴ・画像は転載せず公式参照URLと利用条件だけを記録します。
不明な原価、受注・請求、個人情報、評価点、CO2、能力などを業界平均・推測・ゼロで埋めてはいけません。
出力: (1) Web検索の実施状況と実際の検索語 (2) 参照資料一覧 (3) 出典を紐づけた事実一覧 (4) 未取得項目・理由・次に必要な資料。これは顧客パック作成に渡す素材であり、BASに直接取り込むJSONではありません。
<!-- research:ja:end -->

<!-- research:en:start -->
Research this company on the public internet:
- Public legal company name: {{public legal name}}
- Official domain: {{official domain; disambiguate namesakes if unknown}}
- Reporting period and as-of date: {{period and date}}
Use only public company names and domains as search terms. Do not use internal files, mail, private project names or personal information. If web search is disabled/unavailable, report "blocked" and why; never pretend research ran.
Prioritize official site > brand guide > press kit > IR/annual/regulatory reports > public authorities > reliable news. Distinguish namesakes, parents/subsidiaries, consolidated/standalone scope, fiscal years, actuals/targets.
Investigate company/industry/business, products, locations/public coordinates, customers/suppliers (explicitly documented relationships only), public business roles, strategy/issues/KPIs/initiatives/IT case studies, brand colours/fonts/logo terms, public data dictionaries, glossary, system architecture, relations and core-object candidates.
For each fact record the URL, publisher, publication date (null if unknown), access date, page/section, units, period and scope. Read source pages, not search snippets alone. Retain conflicting facts with both sources. Do not reproduce logos/images; record official reference URLs and usage terms.
Never fill private costs, deals, invoices, personal information, scores, CO2 or capacity with guesses, industry averages or zeroes.
Output: (1) web search status and actual queries (2) source inventory (3) facts mapped to sources (4) gaps, reasons and next required documents. This is material for customer pack assembly, not JSON to import directly into BAS.
<!-- research:en:end -->

## 顧客パック作成 / Customer pack assembly

<!-- prompt:ja:start -->
あなたは業務分析のデータエンジニアです。公開Web調査結果と承認済みのMicrosoft 365資料を統合し、Business Analytics Studio（BAS）の顧客パックJSONを作ってください。このチャットでは社内資料から新しいWeb検索をせず、公開調査は別の資料なしチャットで行います。

# 対象
- 企業: {{企業名}}
- Project: {{Project 名}}（目的: {{業務改善の目的}}）
- 資料: {{ここで / を入力して、ファイル・メール・会議・チャットを参照する}}
- 公開Web調査結果: {{先に実行した公開Web調査の回答を出典URL付きで貼る。未実施なら未実施}}
- 対象期間・基準日: {{期間と日付}}

# 進め方（この順で行う）
1. 資料一覧: 資料名/URLまたはMicrosoft 365内の位置/種類/発行者/発行日（不明は不明）/確認日/対象期間/取得可能な項目/機密区分。未読・権限不足・Web利用不能も明示する。
2. 事実を下の全項目とextensionsに対応づけ、不足する必須項目と次に必要な資料を列挙する。資料にない値は推測・平均・ゼロで埋めない。必須項目が不明なエンティティと、それに依存して成立しないエンティティは除外する。除外理由はcollectionに残す。公開情報だけで案件・原価・請求が揃うと約束しない。
3. JSON の出力: 下の「出力形式」で出す。

# 出力形式
- 各 PART は ```json のコードブロック 1 つだけ。1 回の回答に入れるエンティティは 40 件まで。続きがあれば回答の最後に「続きは『続けて』と送ってください（PART k/N）」と書く。
- PART 1 だけがパック全体の項目を持つ:
  {"part":"1/N","packId":"英小文字とハイフン","company":{"name":{"ja":"","en":""},"industry":{"ja":"","en":""}},"isSample":false,"regions":[{"id":"region-...","name":{"ja":"","en":""}}],"flows":[],"entities":[ sourceから開始。40件を超す出典は次PARTへ ]}
- PART 2 以降: {"part":"k/N","entities":[ ... ]}。extensionsはどのPARTにも追加でき、配列は分割可能。同じ値を矛盾させない。全PARTの総数Nを一致させる。
- flows（物の流れ）: {"source":"仕入先/拠点/顧客/地域id","target":"同様のid","valueT":月間トン,"sourceIds":["sourceのid"]}。同じ対象月・単位の物量があるときだけ。
- optimization: 工場能力・地域需要・生産費・輸送費・CO2・リードタイム・現配分がすべてあるときだけ。{"period":表示文,"sourceIds":["sourceのid"],"plants":[{"siteId":"工場id","capacityT":整数トン,"productionCostPerT":円毎トン,"co2PerT":CO2毎トン}],"regionDemandT":[地域順の整数トン],"transportCostPerT":[[円毎トン]],"leadTimeDays":[[日]],"co2TransportPerT":[[CO2毎トン]],"currentAllocation":[[整数トン]]}。各行列はplants順×regions順、CO2単位と期間を揃える。

# すべてのエンティティに共通の項目（必須）
id, kind, name, description, world, type, classification, author, sourceIds
- 表示文（name・description など）は必ず {"ja":"日本語","en":"English"} の両方。
- id は「英小文字の接頭辞-英小文字・数字・ハイフン」（例: site-tokyo, kpi-otd-rate）。パックの中で一意にする。参照する項目には、このパックに出した id だけを書く。
- sourceIds: 根拠になった source の id。数値を持つ kind（site, product, deal, invoice, issue, solution, kpi, initiative）は 1 件以上必須。根拠のない数値は出さない。
- classification: 社外に見せてよい情報だけ "shareable"。それ以外と迷うものは "internal"。
- author: "ai"
- 日付は YYYY-MM-DD。金額は円の数値（カンマや単位を付けない）。

# kind ごとの項目（world/type はこの値をそのまま書く）
- source（資料そのもの。digital/data）: publisher（表示文）, publishedDate（判明時のみ）, url（https/httpの実際の出典URL。Webは必須）, accessedDate（確認日）, locator（ページ/シート/セル/節/メール・会議の識別情報）, origin は "web"・"m365"。公開日不明を確認日で代用しない。sourceIdsは通常[]。
- site（拠点。real/site）: role は "hq"・"plant"・"dc" のどれか, lat, lon, capacityTPerMonth（月間トン。非生産と確認できる拠点のみ0。不明な能力は0にしない）
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

# extensions（調査対象。事実があるものだけ収録）
- brand: {"primary":"#RRGGBB","foreground":"#RRGGBB","fonts":{"family":"書体","fallbacks":[]},"tone":"formal","source":{"kind":"officialSite","reference":"公開URL","fetchedAt":"確認日時"}}。toneはformal/friendly/energetic/calm、kindはofficialSite/brandGuide/pressKit/irReport。foregroundは明るい背景に4.5:1以上の文字色。ロゴはJSONだけでは取り込めないためlogoを書かずURL・利用条件をsourceに記録。primary不明ならbrandを省略。
- dataCatalog: {"items":[{"id":"任意","name":"テーブル名","description":"説明","columns":["列名"],"domain":"領域","url":"https://出典"}]}。name以外は任意。実レコード・秘密値ではなくデータ辞書。最大5000件。
- glossary: [{"term":表示文,"definition":表示文,"it":IT用語の表示文}]。itは任意。
- graph: {"semantics":{},"relations":[{"source":"id","target":"id","semantic":"dependency","label":表示文}],"twins":[{"digital":"digitalのid","real":"realのid","kind":"represents"}],"flows":[{"source":"id","target":"id","kind":"data","label":表示文}],"layers":{"id":"operations"},"kpiStages":{"kpi-id":"outcome"}}。全節任意。semantic=influence/dependency/causality/ownership/lineage/membership/placement/measurement/control、twin kind=represents/measures/records/displays、flow kind=data/control、layer=operations/experience/insights、stage=input/process/output/outcome。semanticsはBAS関係種別→{"semantic":列挙値,"label":表示文}。未指定は{}にする。既存idだけ参照。
- architecture: {"asIs":[{"layer":"data","name":"現行システム名"}],"toBe":[{"layer":"experience","name":"承認済みの将来構成名"}]}。layer=edge/data/intelligence/process/experience。構想を稼働実績と混同しない。
- coreObject: {"candidates":[{"name":"製品/拠点名","summary":"説明","scores":{"基準id":"出典にある比較値"}}],"criteria":[{"id":"基準id","label":"評価軸"}],"reason":"選定根拠"}。評価点を創作しない。製品/拠点のnameと一致させる。
- 拡張の出典は下のcollectionのsourceIdsに必ず列挙。各画面の既定表示・自動導出と実測データを混同しない。

# 取得報告（extensions.collection、必須）
{"asOf":"YYYY-MM-DD","webSearch":"searched","webSearchReason":"実施状況と理由","sections":[{"key":"company","status":"partial","sourceIds":["sourceのid"],"missingFields":["不足項目"],"reason":"範囲・期間・理由","nextAction":"必要な資料または対応不要"}]}
- webSearchは公開調査結果に基づくsearched/blocked/notRequested。調査不能を実施済みにしない。
- sectionsにはcompany, regions, source, site, person, customer, product, deal, deliverable, invoice, issue, cause, solution, kpi, initiative, supplier, flows, optimization, brand, dataCatalog, glossary, graph, architecture, coreObjectを各1回。status=complete/partial/unavailable/notApplicable。completeは対象範囲を全取得し出典あり・不足なしの場合のみ。未収録はunavailable、対象外は理由を付けnotApplicable。partialでは欠けたフィールドと依存による除外を記録する。
- 社内の担当者・受注台帳・請求台帳・原価表・物流実績・KPI計測表・IT構成表等の追加依頼を具体化する。Projectの分析、OKR、議論、承認、登録ユースケース、ボード、プレゼン、設定は別の作業データであり、このパックでは復元しない。

# 出力の前に自分で確かめること
- すべての id が一意で、参照先の id がパックの中にあり、種類が合っている（ownerId は person、siteId は site など）。
- 数値を持つエンティティすべてに sourceIds がある。
- 資料にない値・人物の私的な情報を書いていない。
- JSON として正しい（コメント・末尾のカンマなし）。
<!-- prompt:ja:end -->

<!-- prompt:en:start -->
Build a BAS customer pack from public web research and approved Microsoft 365 material. No new web searches here: research separately without internal files.

# Scope
- Company: {{company name}}
- Project: {{project name}} (goal: {{business improvement goal}})
- Sources: {{type / here to reference files, mail, meetings and chats}}
- Public web research: {{paste the earlier research with source URLs; say if not done}}
- Reporting period and as-of date: {{period and date}}

# Steps (in this order)
1. Inventory: title, URL/M365 location, type, publisher, publication/access dates, period, fields, confidentiality. Report unknown dates, unreadable files, permissions and blocked searches.
2. Cover ALL kinds/extensions. No guesses, averages or zeroes for unknowns. Omit entities missing required facts and invalid dependents; report gaps/next documents in collection. Web sources cannot supply private deals/costs/invoices.
3. Output the JSON in the format below.

# Output format
- Each PART: one ```json block, at most 40 entities. End with "Send 'continue' (PART k/N)" if more follows.
- Only PART 1 holds the pack-level fields:
  {"part":"1/N","packId":"lowercase-and-hyphens","company":{"name":{"ja":"","en":""},"industry":{"ja":"","en":""}},"isSample":false,"regions":[{"id":"region-...","name":{"ja":"","en":""}}],"flows":[],"entities":[ sources first; split beyond 40 into later PARTs ]}
- Later: {"part":"k/N","entities":[ ... ]}. extensions in any PART; split arrays if needed. Keep N/values consistent.
- flows: {"source":"supplier/site/customer/region id","target":"same kinds","valueT":monthly tonnes,"sourceIds":["source id"]}, only with documented volumes for a consistent period.
- optimization: only if ALL capacities, demand, costs, CO2, lead times and current allocation are known. {"period":text,"sourceIds":["source id"],"plants":[{"siteId":"plant id","capacityT":integer tonnes,"productionCostPerT":JPY per tonne,"co2PerT":CO2 per tonne}],"regionDemandT":[integer tonnes in regions order],"transportCostPerT":[[JPY per tonne]],"leadTimeDays":[[days]],"co2TransportPerT":[[CO2 per tonne]],"currentAllocation":[[integer tonnes]]}. Matrices must be plants rows × regions columns, with consistent periods and CO2 units.

# Fields every entity has (required)
id, kind, name, description, world, type, classification, author, sourceIds
- Display text: {"ja":"Japanese","en":"English"}, both filled.
- id: unique lowercase prefix-letters/digits/hyphens (site-tokyo). References must exist.
- sourceIds: source ids; at least one for site/product/deal/invoice/issue/solution/kpi/initiative. No unsourced numbers.
- classification: "shareable" only if approved for external display, otherwise "internal".
- author: "ai"
- Dates: YYYY-MM-DD. Amounts: plain JPY numbers.

# Fields per kind (write world/type exactly as given)
- source (digital/data): publisher (text), publishedDate (if known), url (http/https; mandatory for web), accessedDate, locator (page/sheet/cells/section/mail/meeting), origin ("web"/"m365"). Unknown publication date: omit, never substitute access date. sourceIds=[].
- site (real/site): role="hq"/"plant"/"dc", lat, lon, capacityTPerMonth (monthly tonnes; 0 only if confirmed non-producing, never unknown)
- person (real/person): role (text), siteId. Sourced business roles only; omit ageBand, gender, portrait.
- customer (real/organization): industry (text), regionId
- product (real/thing): category (text), siteId, unitPriceJpy
- deal (real/event): customerId, productIds (at least one), ownerId (person), stage is "lead", "proposal", "negotiation", "won" or "delivered", valueJpy, closeDate
- deliverable (real/thing): dealId, dueDate, status is "planned", "inProgress" or "done"
- invoice (digital/data): deliverableId, amountJpy, issuedDate, status is "draft", "sent", "paid" or "overdue"
- issue (real/event): impact (1–5), feasibility (1–5), causeIds (cause), kpiIds (kpi)
- cause (real/event): the common fields only
- solution (digital/system): issueIds (1+), kpiIds, msProducts (product-name strings, [] if none), costJpy, annualBenefitJpy
- kpi (digital/metric): unit (text), baseline, current, target, direction is "increase" or "decrease", scale is "ratio" (zero means none) or "interval" (otherwise), period (text), ownerId (person)
- initiative (real/operation): solutionId, start, end, progress (0–1), dependsOn (initiative ids, [] if none), ownerId (person)
- supplier (real/organization): regionId
- Omit illustration; BAS adds decoration.

# extensions (investigate all; include only sourced facts)
- brand: {"primary":"#RRGGBB","foreground":"#RRGGBB","fonts":{"family":"font","fallbacks":[]},"tone":"formal","source":{"kind":"officialSite","reference":"URL","fetchedAt":"access timestamp"}}. tone=formal/friendly/energetic/calm; kind=officialSite/brandGuide/pressKit/irReport. foreground: 4.5:1 on light. Unknown primary: omit brand. Omit logo (no image import); cite official URL/terms.
- dataCatalog: {"items":[{"id":"optional","name":"table name","description":"description","columns":["column"],"domain":"domain","url":"https://source"}]}. Only name is required; at most 5000 items. Collect data dictionaries, not raw records or secret values.
- glossary: [{"term":text,"definition":text,"it":text}]; it is optional.
- graph: {"semantics":{},"relations":[{"source":"id","target":"id","semantic":"dependency","label":text}],"twins":[{"digital":"digital id","real":"real id","kind":"represents"}],"flows":[{"source":"id","target":"id","kind":"data","label":text}],"layers":{"id":"operations"},"kpiStages":{"kpi-id":"outcome"}}. All sections optional. semantic=influence/dependency/causality/ownership/lineage/membership/placement/measurement/control; twin kind=represents/measures/records/displays; flow kind=data/control; layer=operations/experience/insights; stage=input/process/output/outcome. semantics maps BAS relation types to {"semantic":enum,"label":text}; leave {} unless known. Reference existing ids only.
- architecture: {"asIs":[{"layer":"data","name":"current system"}],"toBe":[{"layer":"experience","name":"approved future system"}]}. layer=edge/data/intelligence/process/experience. Distinguish plans from deployed systems.
- coreObject: {"candidates":[{"name":"product/site name","summary":"description","scores":{"criterion-id":"sourced comparison"}}],"criteria":[{"id":"criterion-id","label":"criterion"}],"reason":"selection evidence"}. Match product/site names. Never invent scores.
- Cite extension sources in each collection section's sourceIds. Defaults/derivations are not measurements.

# Collection report (extensions.collection, required)
{"asOf":"YYYY-MM-DD","webSearch":"searched","webSearchReason":"status and reason","sections":[{"key":"company","status":"partial","sourceIds":["source id"],"missingFields":["missing field"],"reason":"scope, period and reason","nextAction":"required document or none"}]}
- webSearch=searched/blocked/notRequested based on the public research, never pretend a blocked search ran.
- Include each key once: company, regions, source, site, person, customer, product, deal, deliverable, invoice, issue, cause, solution, kpi, initiative, supplier, flows, optimization, brand, dataCatalog, glossary, graph, architecture, coreObject. status=complete/partial/unavailable/notApplicable. Complete requires the entire stated scope, sources and no gaps. Omitted data is unavailable, or notApplicable with a reason. Partial must name missing fields and dependency exclusions.
- Request owner lists, order/invoice ledgers, costs, logistics/KPI actuals and IT inventories. Project analyses/OKRs/discussion/approvals/registered use cases/boards/presentations/settings are separate, not restored here.

# Check before you answer
- Unique ids, existing references of the correct kind (ownerId → person, siteId → site).
- Sourced numbers, no invented/private personal facts.
- Valid JSON: no comments/trailing commas.
<!-- prompt:en:end -->
