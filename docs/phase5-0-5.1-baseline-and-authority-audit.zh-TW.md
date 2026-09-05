# Phase 5.0 + 5.1 — Baseline 確認同 Authority Boundary Audit

對應 [`Roadmap.md`](../Roadmap.md) 新版 Phase 5 嘅 [5.0 Two Clocks and Release Policy](../Roadmap.md) 同 [5.1 Threat Model and Authority Boundary](../Roadmap.md)。呢份文件淨係做**文件審計**——記錄現狀、對比 Roadmap 要求、標低差距,冇執行任何 AWS CLI/Console 改動。凡係要真實查 AWS account 先答得到嘅項目,都標咗 ❓ 並列明要行邊條 read-only command 先確認,留俾你決定幾時做。

狀態圖例:✅ 已符合(有 code/文件實證)· ⚠️ 已知差距(記錄咗,暫不阻礙 Sep 28 gate)· ❓ 未知,需要真實 AWS 查證

---

## 5.0 — Two Clocks and Release Policy(Build Day 1 baseline)

```text
Data Day 1   = 2026-08-30
Data Day 7   = 2026-09-05（今日,Build Day 2)
Data Day 30  = 2026-09-28 = Build Day 25
```

### Phase 1–4 完成度 baseline

上一輪已經對過新版 Roadmap.md 同現存 source(見 git log),搵到嘅唯一差距(Holodex footer attribution slot)已經修好:[`DashboardFooter.tsx`](../frontend/dashboard/src/components/DashboardFooter.tsx)、wiring 喺 [`DashboardPage.tsx`](../frontend/dashboard/src/components/DashboardPage.tsx)、測試喺 [`DashboardPage.test.tsx`](../frontend/dashboard/src/components/DashboardPage.test.tsx)。

現存 `src/` 已實現嘅模組(對應 Roadmap 1.x–4.x):collection(`main.py`、`video_discovery.py`、`tracking_schedule.py`)、AWS 儲存(`dynamodb_store.py`、`lambda_handler.py`)、analytics/read API(`view_growth_analytics.py`、`trending.py`、`read_api.py`、`api_handler.py`)、client identity/notification(`client_credential_api.py`/`_store.py`、`notification_dispatcher.py`、`push_sender.py`、`heartbeat_api.py`)。✅ 符合「Phase 1–4 already complete」嘅前提。

### 29/30 日 delta 唔可以砌數 —— 已經喺計算層做到

Roadmap 5.0:「Any metric that requires a full elapsed 30-day delta must use an earlier verified baseline; otherwise the UI must show the actual covered duration and must not fabricate YouTube history.」

✅ [`view_growth_analytics.py:98-120`](../src/view_growth_analytics.py) 嘅 `calculate_growth` 已經做緊呢個保證:一個缺咗嘅 comparison point,喺 `max(COLLECTION_START_DATE, earliest_available_date)` 之前分類做 `not_available`(永遠唔會 resolve),之後分類做 `pending`(仲未收到,唔係冇)。全程唔會用 0 頂替、唔會靜雞雞攞第二個日期嘅 snapshot 充當。`COLLECTION_START_DATE = date(2026, 8, 29)` 已經係呢個 project 自己嘅真實開始日,唔係憑空捏造。

⚠️ **已知差距,建議列做未來 UI 工作,唔屬於 5.0/5.1 呢兩個純審計 sub-section**:計算層唔會砌數,但前端而家攞到 `status: pending/not_available` 之後,冇一個好明顯嘅「呢個 view 實際覆蓋緊幾多日歷史數據」全局提示(例如揀 30d 但實際上收集咗淨係 7 日)。個別 KPI 已經用 `"N/A"` 頂住冇數嘅情況([`DashboardPage.tsx:120-124`](../frontend/dashboard/src/components/DashboardPage.tsx)),但冇一句好似「目前覆蓋 7/30 日歷史數據」咁嘅明確字句。呢個唔會令數據砌假(status 已經擋住咗),淨係體驗上唔夠透明。建議留返做 Phase 6/7 UI 工作嘅其中一項,唔喺而家 5.0/5.1 做。

---

## 5.1 — Threat Model and Authority Boundary Audit

Roadmap 要求嘅 authority table,逐行對比現狀(根據 [`docs/aws-setup.zh-TW.md`](aws-setup.zh-TW.md) 記錄嘅 2.1/2.2 設置過程 + 現存 code review):

| Roadmap 要求 | 現狀 | 判定 |
| --- | --- | --- |
| `public frontend → no AWS credentials, admin key, or delete capability` | Grep 咗成個 `frontend/dashboard/src`,冇任何 `boto3`/`aws-sdk`/AWS endpoint 字眼——前端淨係用 `fetch()` 打自己嘅 API,冇任何 AWS 憑證 | ✅ |
| `public read API → allowlisted, bounded reads only` | [`read_api.py`](../src/read_api.py) 對 `creatorId`/`organization`/`reportDate`/`timeZone`/`period`/`rankingType`/`limit` 每個 query param 都驗證,invalid 即刻 `ClientError`(見上一輪 Roadmap 對照,呢段本身已經 implemented 兼有 docstring) | ✅ |
| `client preference API → only that client's low-risk state; authenticated and rate-limited` | Auth 部分:[`client_credential_api.py`](../src/client_credential_api.py) 嘅 `X-Client-Secret` 已經做咗(PR #18)。**Rate-limit 部分未搵到對應 code**——`api_handler.py` 冇睇到 per-client throttle 邏輯,呢個本身屬於 5.3(Cost and Abuse Containment)嘅 API Gateway 層嘢,唔係呢個 Lambda code 自己應該做 | ⚠️(rate-limit 部分屬 5.3 範圍,非 5.1 缺口) |
| `admin API → separate route, origin, and strong human authentication` | [`api_handler.py:69-70`](../src/api_handler.py) 嘅 `_ADMIN_PROTECTED_ROUTES`(`POST /remote-config`、`GET /admin/heartbeat-stats`)其實同public 路由行埋同一個 API Gateway/同一個 Lambda,淨係用一條共享嘅 `YOBI_ADMIN_API_KEY`(`X-Admin-Key` header)分辨,唔係獨立 route/origin,亦唔係「strong human authentication」(冇 MFA、冇個人帳戶,係一條共享密鑰) | ⚠️ 已知差距——Roadmap Phase 8(Admin Operations and MVP Release Gate)本身列明要「Stronger admin authentication than anonymous client identity」同「Separate backend authorization」,即係話依家呢個共享 key 做法已經被 Roadmap 自己定義為過渡狀態,Phase 8 先解決,唔使而家郁 |
| `collector role → write only required collection records` | **已查證(2026-09-05,`yobi-analytics-cli` read-only)**:`aws iam list-attached-role-policies`/`list-role-policies --role-name yobi-analytics-lambda-role` 兩條都俾 `AccessDenied` 擋咗——`yobi-analytics-cli` 自己都冇權睇呢個 role 實際掛緊咩 policy(`PowerUserAccess` 刻意唔包 IAM,`YobiLambdaRoleScopedAccess` 淨係俾 `CreateRole`/`GetRole`/`AttachRolePolicy`/`PassRole`,冇包 `List*`)。`aws iam get-role` 查到嘅淨係 role metadata(建立於 2026-08-30T13:57:12Z,`MaxSessionDuration: 3600`),睇唔到實際權限內容 | ❓ **仲未解決**——依家嘅 CLI 身份結構性咁查唔到自己個 Lambda role 有咩權限,要麼用 root Console 睇一次(IAM → Roles → yobi-analytics-lambda-role → Permissions),要麼將 `iam:ListAttachedRolePolicies`/`iam:ListRolePolicies`(淨係俾呢一個 role)加入 `YobiLambdaRoleScopedAccess`,長遠嚟講後者仲啱——一個負責部署嘅身份連自己部署緊嘅 role 有咩權都睇唔到,本身都算一個小缺口 |
| `read role → read only required indexes and attributes` | **已查證**:`aws lambda list-functions` 顯示三個已部署嘅 function——`yobi-analytics-collector`、`yobi-analytics-api`(Read API)、`yobi-analytics-notification-dispatcher`——**全部三個共用同一個** `arn:aws:iam::189461315571:role/yobi-analytics-lambda-role`,冇分開 read/collector/dispatcher role | ⚠️ **確認咗係差距**,唔再係未知數:read、write(collector)、dispatcher 三種完全唔同嘅權限需求而家掛喺同一條 role 度,即係話 read API 一旦俾人攻陷,理論上同一個 role 嘅權限(如果掛咗 DynamoDB 寫權)一樣用得。由於上面嗰項查唔到呢個 role 實際有咩 policy,暫時未知實際 blast radius 有幾大,但「三個 function 冇分 role」呢個事實本身已經同 Roadmap 5.1 嘅「read role/collector role 分離」原則有落差,建議 5.2 或之後拆返做至少兩條 role(read-only DynamoDB vs collector 嘅 read+write) |
| `deployment role → infrastructure deployment only, using temporary credentials` | `yobi-analytics-cli` 用嘅係 [`docs/aws-setup.zh-TW.md` §1.6](aws-setup.zh-TW.md) 講嘅**長期 access key**(`aws configure` 寫死落本機),唔係 IAM Identity Center/assumed-role 嘅臨時憑證 | ⚠️ 已知差距——依家單人開發階段用長期 key 屬合理過渡,但 Roadmap 5.1 嘅理想狀態係臨時憑證;若日後要正式過 5.1 exit gate,呢項要處理(換用 IAM Identity Center 或最少定期輪換+限縮權限) |
| `root user → emergency/account tasks only; never used by code or Claude Code` | MFA 已開([§1.4](aws-setup.zh-TW.md))、root 嘅 programmatic access key 已停用([§1.8](aws-setup.zh-TW.md))。**但** [§2.4](aws-setup.zh-TW.md) 明確記錄:因為 `PowerUserAccess` 刻意唔包 IAM,建 `yobi-analytics-lambda-role`、掛 `YobiLambdaRoleScopedAccess` 呢類 IAM 操作全部要用 root Console 直接做——即係話 root 唔止俾「緊急/帳戶」用,仲被日常攞嚟做 IAM role 設置 | ⚠️ 已知差距——單次初始設置階段用 root 開 role 屬合理(IAM Identity Center 都需要 root 先設得起),但之後任何新增/修改 IAM role 都應該諗辦法唔再用 root Console,改用更受限嘅方式(例如 IAM Identity Center 嘅 privileged session),而唔係將呢個變成日常習慣 |

### 額外搵到嘅殘留風險(唔喺上面張表,但同 5.1 嘅 threat model 直接相關)

**`YOUTUBE_API_KEY` 用 plaintext Lambda 環境變數存,唔係 AWS Secrets Manager。** [`docs/aws-setup.zh-TW.md` §2.7](aws-setup.zh-TW.md) 記低咗一次真實事故:第一次 set 環境變數嗰陣,`aws lambda update-function-configuration`/`get-function` 嘅 output 內建夾住個環境變數真實值,連續兩次冇過濾就貼晒出嚟,condition 導致個 key 曝光兩次,要去 Google Cloud Console 換新 key。雖然已經 fix 咗「以後查詢一律加 `--query` 剔走 `Environment` field」呢個操作習慣,但**個 key 本身依然係 plaintext 存喺 Lambda config**——任何攞到 `lambda:GetFunctionConfiguration` 權限嘅身份(包括依家嘅 `yobi-analytics-cli`)都睇到晒。呢個屬於 Roadmap 5.2/5.3(Data Protection/Cost Containment)嘅 secret management 範疇,建議之後做 5.2 嗰陣一拼將 `YOUTUBE_API_KEY`(同將來嘅 `HOLODEX_API_KEY`)搬去 Secrets Manager,Lambda 淨係存個 ARN reference。

---

## 總結:5.1 Exit Gate 現狀

Roadmap 5.1 冇獨立 exit gate(合埋喺 Phase 5 Exit Gate 一齊審),但按上面張表:

- ✅ 3 項已符合(public frontend 冇憑證、public read API bounded、root MFA+key 已停用)
- ⚠️ 5 項已確認差距,唔急住做,暫時唔阻塞 Sep 28 gate(admin 分離留俾 Phase 8、deployment role 長期 key、root 日常做 IAM、YOUTUBE_API_KEY plaintext、三個 Lambda 共用一條 execution role)
- 🔴 1 項高風險,**建議喺 Sep 28 gate 之前處理**:`yobi-analytics-lambda-role` 掛咗 `AmazonDynamoDBFullAccess`,對公眾開放嘅 read API 同 collector/dispatcher 共用呢條 role,任何一個俾人打穿都可以刪表/閂 PITR(見下面更新同建議修復)

**2026-09-05 更新:兩條 ❓ 都清咗——一條靠 CLI read-only 查到,一條你自己用 root Console 睇咗個 Permissions policies tab 影低。第二條揭發咗一個 🔴 高風險嘅實際差距,唔止「未知」咁簡單。**

- `read role`/`collector role` 分離 → 已確認**冇分離**:`yobi-analytics-collector`、`yobi-analytics-api`、`yobi-analytics-notification-dispatcher` 三個 Lambda 全部共用 `yobi-analytics-lambda-role`,轉做上面表入面嘅 ⚠️ 項。

- `yobi-analytics-lambda-role` 實際掛緊咩 policy → **已確認,揭發 🔴 高風險缺口**。root Console 嘅 Permissions policies tab 顯示掛咗 3 條:

  | Policy | Type | 實際權限範圍 |
  | --- | --- | --- |
  | **`AmazonDynamoDBFullAccess`** | AWS managed | 🔴 呢個先係問題核心——俾埋成個 AWS account **所有** DynamoDB table 嘅**所有** action,包括 `DeleteTable`、`UpdateTable`、`DeleteBackup`、`UpdateContinuousBackups`(即係控制 PITR 開關嗰個 action)、`PutItem`/`DeleteItem`/`Scan` on any table——完全唔限喺 Yobi 自己嘅 8 張表 |
  | `AWSLambdaBasicExecutionRole` | AWS managed | CloudWatch Logs 寫入權,冇問題,符合 collector/read role 應有嘅最小權限 |
  | `YobiPhase4TablesAccess` | Customer inline | 睇 console 顯示大概係專門收窄俾 Phase 4 幾張表(`YobiClientCredentials`/`YobiHeartbeat`/`YobiNotificationEvents`/`YobiRemoteConfig`/`YobiNotificationDeliveryLog`)嘅 scoped policy——但因為 `AmazonDynamoDBFullAccess` 已經全開,呢條窄 policy 而家完全冇實際收窄作用,形同虛設 |

  **點解呢個係 🔴 唔係 ⚠️:** Roadmap 5.1 寫明「collector role → write only required collection records」「read role → read only required indexes and attributes」,5.2 仲寫明「Deny `DeleteTable`, backup/PITR disabling, and destructive infrastructure actions to runtime roles」——`AmazonDynamoDBFullAccess` 三樣都直接違反。而三個 Lambda(包括對公眾開放嘅 `yobi-analytics-api` read API)共用呢一條 role,即係話**萬一 read API 有一個未來先發現嘅漏洞俾人打穿(例如某個未驗證好嘅 query 參數),攻擊者透過嗰個 Lambda 攞到嘅權限,已經夠刪除生產 DynamoDB table、閂咗 PITR** ——唔止「攞到唔應該攞到嘅數據」咁簡單,係可以整場成個 project 嘅歷史數據冇咗。

  **建議修復(留返俾你決定幾時做,我冇喺 AWS 度郁過任何嘢)**:喺 IAM → Roles → `yobi-analytics-lambda-role` → 剔走 `AmazonDynamoDBFullAccess`,換一條淨係俾 `GetItem`/`PutItem`/`Query`/`Scan`/`DeleteItem`/`BatchWriteItem`(現存 code 用嘅 action 就係呢 6 個,冇 `UpdateItem`,`grep` 咗全個 `src/` 冇搵到)、Resource 收窄做 8 張表自己嘅 ARN 嘅 inline policy——JSON 範本:

  ```json
  {
    "Version": "2012-10-17",
    "Statement": [
      {
        "Sid": "YobiDynamoDbTablesOnly",
        "Effect": "Allow",
        "Action": [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:DeleteItem",
          "dynamodb:BatchWriteItem"
        ],
        "Resource": [
          "arn:aws:dynamodb:ap-northeast-1:189461315571:table/YobiVideoMaster",
          "arn:aws:dynamodb:ap-northeast-1:189461315571:table/YobiSnapshots",
          "arn:aws:dynamodb:ap-northeast-1:189461315571:table/YobiRunSummaries",
          "arn:aws:dynamodb:ap-northeast-1:189461315571:table/YobiNotificationDeliveryLog",
          "arn:aws:dynamodb:ap-northeast-1:189461315571:table/YobiClientCredentials",
          "arn:aws:dynamodb:ap-northeast-1:189461315571:table/YobiHeartbeat",
          "arn:aws:dynamodb:ap-northeast-1:189461315571:table/YobiNotificationEvents",
          "arn:aws:dynamodb:ap-northeast-1:189461315571:table/YobiRemoteConfig"
        ]
      }
    ]
  }
  ```

  呢條範本本身都仲未做到「read/collector/dispatcher 分開 role」呢個更完整嘅目標(3 個 Lambda 依然共用一條 role,淨係頂住咗 FullAccess 呢個立即嘅高風險缺口),但即刻攔截咗最嚴重嗰部分——`DeleteTable`/PITR 停用/任意 table 嘅權限。如果想一步到位分開三條 role,可以之後再做,唔急住同呢個 fix 綁埋一齊。

  **CodeRabbit review 補充(2026-09-05):**

  1. **上面條範本本身有個漏洞,已經喺實際套用嗰陣搵到並修正咗**——`Resource` 淨係得表本身嘅 ARN,冇包埋 GSI 嘅 `.../index/creatorId-index` ARN。DynamoDB 嘅 IAM 權限入面,一張表同佢自己嘅 GSI 係兩個獨立 resource,淨係俾表 ARN 唔夠俾 `Query` 一個 index。呢個問題喺同一晚稍後(加 `creatorId-index` GSI 嗰陣)真係撞到 `AccessDeniedException`,即場加多一條 `arn:.../table/YobiVideoMaster/index/*` 落 `Resource` 先解決——**即係話你依家實際套用咗嘅 policy,已經包埋呢條 index ARN,唔係停留喺上面呢個舊版範本嘅狀態。**
  2. **「將呢條有寫入權嘅 policy 掛落三個 Lambda 共用嘅 role」本身確實有風險**,CodeRabbit 建議應該先分開 role,先至掛呢類政策。呢個取捨係刻意做嘅:即刻換走 `AmazonDynamoDBFullAccess`(帳戶層面、無限制嘅高風險)相比起「三個 Lambda 共用一條收窄咗嘅 role」,已經係大幅收窄咗嘅 blast radius,而分 3 條 role 係一個規模大好多嘅獨立任務——上面已經記低咗做已知、有意識延後嘅項目,唔係漏做,係刻意分先後緩急處理。

最新一輪三個 Lambda 現況(`aws lambda list-functions`,2026-09-05):

| Function | 最後更新 | Execution Role |
| --- | --- | --- |
| `yobi-analytics-collector` | 2026-09-02T16:07:13Z | `yobi-analytics-lambda-role` |
| `yobi-analytics-api` | 2026-09-03T15:07:10Z | `yobi-analytics-lambda-role`(同上,共用) |
| `yobi-analytics-notification-dispatcher` | 2026-09-03T13:47:06Z | `yobi-analytics-lambda-role`(同上,共用) |
