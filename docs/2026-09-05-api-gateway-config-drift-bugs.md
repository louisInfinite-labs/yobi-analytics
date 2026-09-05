# API Gateway 設定漏洞 —— 2026-09-05 發現

喺做 Roadmap 5.3(Cost Guardrails)嘅時候,查 `yobi-analytics-http-api`(`k76ct6q0j0`)呢個真正對外開放嘅 API Gateway 現況,搵到 3 個問題。三個都唔係 Python code 本身嘅 bug——`src/` 底下嘅程式碼冇錯,問題出喺 **API Gateway 呢一層設定,同 code 唔同步**。

---

## Bug 1:API Gateway 完全冇設 throttle(流量上限)

### 1. 點解會變成現家咁

`yobi-analytics-http-api` 呢個 API Gateway 喺 Roadmap 4.1 嗰陣建立,目的純粹係「令 Lambda 對外開放,行得通」——嗰陣時 Roadmap 5.3(Cost and Abuse Containment)呢個階段仲未到,起呢個 API Gateway嘅人(或者session)理所當然咁冇諗到要設 throttle,AWS 預設又唔會自動幫你設一個貼身嘅上限(佢個帳戶層面預設上限本身係俾成個 AWS 帳戶所有 API 共用,數值好高,對一個細專案嚟講等於冇限制)。即係話呢個唔係手民之誤漏咗一個掣,係「起嗰陣個階段仲未行到嗰步」。

### 2. 現家咁有咩問題

`aws apigatewayv2 get-stages` 查到 `ThrottlingBurstLimit`/`ThrottlingRateLimit` 都係 `null`——**準確啲講,呢個係「冇設 API 專屬嘅 throttle」,唔係「完全冇任何節流」**:AWS 帳戶層面本身有一個俾成個帳戶所有 API 共用嘅預設 regional throttle(數值好高,對一個細專案嚟講形同虛設)。即係話呢個 API 冇自己專屬、貼身嘅上限,淨係靠緊帳戶層面嗰個好闊嘅預設值頂住。一個惡意/意外嘅流量爆發(scraper、重複重試嘅壞 client、單純多咗人用)可以幾乎毫無阻攔咁直達 Lambda,再直達 DynamoDB。Lambda 自己雖然有 reserved concurrency 可以設(依家未設),DynamoDB on-demand 都有自己嘅彈性上限,但 **Gateway 呢一層本身應該係第一道專屬防線**,而家形同虛設。

### 3. 點解決

幫 `$default` stage 加返 `ThrottlingBurstLimit`/`ThrottlingRateLimit`:

```bash
aws apigatewayv2 update-stage --api-id k76ct6q0j0 --stage-name '$default' \
  --default-route-settings ThrottlingBurstLimit=20,ThrottlingRateLimit=10 \
  --region ap-northeast-1
```

（如果個 stage 係 `ApiGatewayManaged: true`,`update-stage` 會拒絕修改——遇到呢種情況要改用一個 customer-managed stage 先做得到自訂 throttle。今次呢個 `$default` stage 唔屬於呢種情況,`update-stage` 直接生效。）

數值(瞬間 20、每秒 10)按專案現時規模(Roadmap 6 初始目標受眾係 ~500 人嘅 Discord 群組)訂,留有餘裕俾一個用戶打開 dashboard 一次過發嘅幾個 API call,同時遠低於任何真正濫用嘅流量級數。

### 4. 可以阻止到咩 case

- 一個壞掉、陷入死循環嘅 client(例如前端 bug 令佢每秒發幾百個 request)唔會直接拖冧成個系統
- 有人(或者機械人/爬蟲)刻意/唔小心大量掃呢個 public API,唔會令 DynamoDB 讀寫費用/Lambda invoke 費用短時間內暴升,間接保住個 `$5` budget 唔會爆
- 為之後(Roadmap 5.3 講嘅)「incident switch」爭取反應時間——起碼流量嚟緊嗰陣唔係完全冇閘

---

## Bug 2:CORS `AllowHeaders` 漏咗 `x-client-secret`

### 1. 點解會變成現家咁

CORS 設定(`AllowOrigins`/`AllowMethods`/`AllowHeaders`)喺 API Gateway 起嗰陣已經設好,當時得 `content-type`、`x-admin-key` 兩個 header。之後 PR #18 先至喺 **code 入面**加咗 `X-Client-Secret` 呢個新 header 嘅要求(`api_handler._require_client_secret`,保護 push-subscription/notification-preference/`GET /remote-config` 呢幾條路由)——但改 code 嗰陣冇同步返去 API Gateway 度加返呢個新 header 落 CORS allowlist。呢個係典型嘅「code 進化咗,但基建設定冇跟住郁」嘅情況(Infrastructure drift)——如果之前有做咗 IaC,呢類 code/infra 唔同步好易可以自動偵測到。

### 2. 現家咁有咩問題

CORS 嘅 `AllowHeaders` 冇列出嘅 header,瀏覽器根本唔會俾 JavaScript 帶佢去做 cross-origin request——preflight (`OPTIONS`) 會直接拒絕,個真正 request 連發都未發到 Lambda 度就俾瀏覽器自己擋咗。即係話:**任何一個真正部署咗嘅 Dashboard(瀏覽器),想帶住 `X-Client-Secret` 去 call 呢幾條受保護嘅路由,一定會失敗**——唔係得到 403(冇權限),係連 request 都送唔到,瀏覽器 console 會見到 CORS error。之前用 `aws lambda invoke`/PowerShell 測試冇撞到呢個問題,係因為嗰啲測試方式根本唔係瀏覽器,唔會受 CORS 管——所以呢個 bug 一直隱藏緊,要等真正瀏覽器接上先會爆出嚟。

### 3. 點解決

```bash
aws apigatewayv2 update-api --api-id k76ct6q0j0 --region ap-northeast-1 \
  --cors-configuration AllowOrigins="*",AllowMethods=GET,POST,PUT,DELETE,AllowHeaders=content-type,x-admin-key,x-client-secret
```

### 4. 可以阻止到咩 case

- Dashboard 用戶想開啟/關閉某個 creator 嘅通知、想訂閱/取消 push notification——依家開始至真正做得到,唔會靜靜雞失敗
- 避免上線之後先發現「個功能寫咗都用唔到」,靠用戶投訴先發現,而係今日主動查出嚟

---

## Bug 3:`POST /clients/{clientId}/credential` 呢條 route 冇部署上 API Gateway

### 1. 點解會變成現家咁

同 Bug 2 一樣嘅根源:`client_credential_api.py`/`_handle_post_client_credential` 呢個 handler 係 PR #18(client-secret hardening)先新增落 `api_handler.py` 嘅 `ROUTES` dict 度。但 API Gateway 嗰邊嘅 route 清單(`aws apigatewayv2 create-route` 呢類設定)冇跟住呢次 code 改動去補一條新 route——即係話 code 度识得呢個 route、Lambda 入面 handler 都寫好晒,但外面嘅 API Gateway 從來冇幫呢條路開過門。

### 2. 現家咁有咩問題

`aws apigatewayv2 get-routes` 查到成個 API 得返 11 條 route,`POST /clients/{clientId}/credential` 唔喺入面。前端(`clientCredential.ts` 嘅 `getOrCreateClientSecret`)理應要 call 呢條 route 先攞到一個新 client secret——但依家呢條路根本去唔到,call 落去會撞 API Gateway 自己嘅 404(連 Lambda 都未輪到收到 request)。**結果係:冇任何真正用戶可以攞到 client secret,連 Bug 2 嗰個問題都未輪到爆——因為第一步(攞 secret)已經行唔通。**

### 3. 點解決

```bash
aws apigatewayv2 create-route --api-id k76ct6q0j0 --route-key "POST /clients/{clientId}/credential" \
  --target integrations/a8g10xr --region ap-northeast-1
```

（沿用現有嗰個共用 integration `a8g10xr`,唔使開新 integration。）

### 4. 可以阻止到咩 case

- 呢個係三個 bug 入面**最關鍵**嘅一個——冇呢條 route,成套 PR #18 client-secret 認證機制對真實用戶嚟講完全形同虛設,唔理 Bug 2 修唔修都好
- 補返之後,前端先有可能真正完成「註冊 → 攞 secret → 帶住去 call 受保護路由」呢一條完整流程

---

## 共通教訓

Bug 2 同 Bug 3 嘅根源完全一樣:**Python code(`api_handler.py`)改咗,冇人記得同步去改 API Gateway 嘅設定。** 呢個正正係之前傾開嘅 IaC(Infrastructure as Code)想解決嘅問題——如果 API Gateway 嘅 route/CORS 設定都寫喺 code 度(同 `api_handler.py` 擺埋一齊、一齊 review、一齊 deploy),呢類「code 加咗新嘢,infra 冇跟到」嘅情況根本唔會發生,一 deploy 就自動同步埋。依家淨係一個人手動維護兩個地方(code + Console/CLI 設定),漏嘢係遲早嘅事。
