# AWS 環境設置教學

記錄由零開始設置 AWS 環境嘅完整過程,對應 [`Roadmap.md`](../Roadmap.md) 嘅 2.1(AWS Account and CLI Setup)同 2.2(Lambda Manual Deployment,**已完成**)。

---

## Part 1:AWS 帳戶基礎設置(2.1)

### 1.1 分清楚 AWS Builder ID 同真正嘅 AWS 帳戶

呢兩個係完全唔同嘅系統,好易混淆:

- **AWS Builder ID**——一個輕量級嘅個人登入身份,用嚟登入 AWS Skill Builder(教學課程)、AWS re/Post(社群)、Amazon Q Developer、CodeCatalyst 呢類工具。**冇** IAM、billing、Lambda、DynamoDB、EC2 等雲端服務。
- **AWS 帳戶(root account)**——要用信用卡開戶,先有 IAM、billing、Lambda、DynamoDB 等等成套雲端服務。喺 [aws.amazon.com](https://aws.amazon.com/) 右上角「Create an AWS Account」開戶。

如果喺 IAM 度搵唔到嘢、或者顯示「已經註冊過」,好可能係你用緊 Builder ID,或者個 email 其實已經有一個真正嘅 root 帳戶——去 [console.aws.amazon.com](https://console.aws.amazon.com/) 揀「Root user」,用你個 email 試登入(唔記得密碼可以用「Forgot password」重設)嚟確認。

### 1.2 揀 Region

用 **Asia Pacific (Tokyo)**,代碼 `ap-northeast-1`——同專案嘅時區設計一致(collector 預定 18:00 Asia/Tokyo 跑)。

留意 AWS region 清單用嘅係城市名,唔係國家名,搜尋要打「Tokyo」唔係「Japan」。可以喺「Account → AWS Regions」check 呢個 region 係咪已經「Enabled by default」(通常都係)。

### 1.3 裝 AWS CLI v2(Windows)

唔使識砌 command,直接用官方 MSI 安裝檔:

```
https://awscli.amazonaws.com/AWSCLIV2.msi
```

Download 完 double-click 安裝,跟住精靈一路 Next 就得(會彈 UAC 確認)。裝完**開一個新 terminal**(PowerShell 或 Git Bash 都得,唔分),打:

```bash
aws --version
```

見到似 `aws-cli/2.x.x Python/3.x.x Windows/10 ...` 就代表裝好。

### 1.4 開 Root 嘅 MFA(多重驗證)

登入 root 帳戶,跟指示開 MFA:

- 裝置名稱純粹係你自己識別用嘅標籤(隨便打,例如 `MyPhone`),唔係密碼
- 冇實體 security key 嘅話揀「Authenticator app」,用手機裝 Google Authenticator 或 Microsoft Authenticator
- Scan QR code,跟住連續輸入兩個 6 位數字 code 完成綁定

### 1.5 開 IAM User 俾 CLI 用(唔用 root)

**唔好日常用 root 做操作。** 跟住做:

1. IAM → Users → Create user
2. User name 打 `yobi-analytics-cli`
3. **唔好剔**「Provide user access to the AWS Management Console」(呢個 user 純粹俾 CLI 用,唔需要登入網頁)
4. Set permissions 揀「Add user to group」(AWS 推薦嘅做法,好過逐個 user 掛 policy)
5. Click「Create group」,group name 打 `yobi-analytics-admins`,search 加 `PowerUserAccess` 呢個 policy
6. 剔選啱啱開嘅 group,Next → Create user

**`PowerUserAccess` 係乜:** 一個 AWS managed policy,俾你幾乎所有 AWS 服務嘅權(Lambda、DynamoDB 等等),**但唔畀一般嘅 IAM user/role 管理權**(冇 `iam:CreateRole`,開唔到新 role;`iam:CreateUser`/`iam:AttachUserPolicy` 呢類都冇)。留意佢**唔係完全冇任何 IAM action**——`iam:CreateServiceLinkedRole`、`iam:ListRoles` 呢類其實包咗喺入面,淨係將「開一般 role/user、改權限」呢類刻意剔走,留低做安全邊界。

### 1.6 攞 Access Key + `aws configure`

⚠️ **呢個做法(長期 access key,寫死落 `aws configure`)淨係啱 bootstrap/開發初期用。** 日常操作應該用 IAM Identity Center 或者 assumed role 嘅臨時憑證,唔應該長期靠一條永久有效嘅 access key。如果好似依家咁保留咗長期 key,務必做埋定期輪換、監察使用記錄、一有懷疑就即刻 revoke。

1. 入返 `yobi-analytics-cli` 個 user → 「Security credentials」tab → 「Create access key」
2. 用途揀「Command Line Interface (CLI)」
3. 會 show **Access Key ID** 同 **Secret Access Key**——Secret **淨係呢一次顯示**,記得 download `.csv` 或者 copy 落安全地方

**呢兩條 key 唔好貼落 chat 度,直接攞去落一步用就得。**

喺 terminal 打:

```bash
aws configure
```

逐項填:

```
AWS Access Key ID: <貼 Access Key ID>
AWS Secret Access Key: <貼 Secret Access Key>
Default region name: ap-northeast-1
Default output format: json
```

### 1.7 驗證 CLI 連接成功

```bash
aws sts get-caller-identity
```

見到類似咁就代表成功,而且證明用緊 IAM user 唔係 root:

```json
{
  "UserId": "...",
  "Account": "189461315571",
  "Arn": "arn:aws:iam::189461315571:user/yobi-analytics-cli"
}
```

### 1.8 停用 Root 嘅 Access Key

IAM Dashboard 通常會有個 Security recommendations 提示「Deactivate or delete access keys for root user」——click「Manage access keys」,將 root 自己嘅 access key 刪除/停用(如果有嘅話)。日常已經用 IAM user 嘅 key,root key 淨係增加風險。

**呢步淨係停用 root 嘅 Access Key(programmatic 用嗰條),同 root 嘅 Console 登入(email+password+MFA)完全係兩回事——Console 登入唔會受影響、都唔應該停用**,因為之後有啲 IAM 操作(例如開 role)一定要用 root Console 先做得到。

### 1.9 開 Billing/Budget Alerts

AWS Console 搜尋「Billing and Cost Management」→「Budgets」→「Create budget」:

- Customize (advanced) → Cost budget
- Budget name:`yobi-analytics-monthly`
- Period:Monthly,Recurring budget
- Budgeted amount:`5`(USD)
- Budget scope:All AWS services
- Aggregate costs by:用預設 Unblended costs
- Configure alerts:加兩條
  - Threshold `20`%,Trigger `Actual` → 大約 $1 warning
  - Threshold `100`%,Trigger `Actual` → $5 stronger warning
  - 兩條都填自己 email
- Tags:optional,skip
- Budget actions:唔使加(進階自動化功能,唔啱而家用)
- Review → Create

到此 2.1 完成,DoD 全部達成,冇涉及任何 repo 入面嘅 code,唔使 commit/PR。

---

## Part 2:Lambda 部署(2.2,已完成)

### 2.1 發現嘅問題:Lambda 部署目錄係唯讀

本機收集器將 `creators.json`、`video_master.json`、`snapshots/` 寫落去 source code 同一個目錄。但 **Lambda 部署上去嗰個目錄本身唯讀**——一 write 就直接 `PermissionError`。

**Fix:** [`src/json_store.py`](../src/json_store.py) 加咗:

```python
DATA_DIR = Path(os.environ.get("YOBI_DATA_DIR") or str(Path(__file__).parent))
```

本機開發預設冇 set 呢個環境變數,行為完全不變;Lambda 部署時 set 做 `/tmp`(Lambda 入面唯一寫得嘅地方)。`video_master.json`、`snapshots/` 跟呢個做。

⚠️ **`YOBI_DATA_DIR=/tmp` 淨係呢一節(2.2)測試部署用嘅權宜之計,唔係正式生產環境嘅做法。** `/tmp` 係 Lambda 執行環境自己嘅暫存空間,cold start 之後隨時會清空,用嚟存 `video_master.json`/`snapshots/` 呢類需要長期保留嘅追蹤狀態,一旦 cold start 就有機會令追蹤歷史/去重複狀態被重置。真正生產環境收集數據之前,一定要換用 2.3 嘅 DynamoDB(`YOBI_STORAGE_BACKEND=dynamodb`),唔可以停留喺呢個 `/tmp` 方案。

**留意:`creators.json` 特登冇跟呢個機制**——因為佢係固定參考資料,冇任何地方會喺 runtime 寫佢,所以佢繼續讀 package path(Lambda 讀得,淨係唔寫得)。試過將佢都 redirect 去 `/tmp`,發現係個真 bug:`/tmp/creators.json` 喺 Lambda 度根本唔存在(冇 bootstrap 步驟 copy 個 file 過去),結果 `load_creators()` 靜靜雞回傳空 list,`main()` 會 exit 0 印「No active creators.」,實際上一條片都冇收集到,而且完全冇 error 提示。

### 2.2 寫 Lambda entry point

[`src/lambda_handler.py`](../src/lambda_handler.py)——一個薄 wrapper 包住而家嘅 `main()`:

```python
def lambda_handler(event, context):
    exit_code = main()
    if exit_code != 0:
        raise RuntimeError(f"Collection job failed (exit code {exit_code})...")
    return {"statusCode": 200}
```

失敗嗰陣特登 `raise`(而唔係靜靜雞 return),等 AWS Lambda 自己嘅 invocation-error 指標會標記到「呢次 invoke 失敗咗」,將來用 CloudWatch alarm 監察先睇得到。

### 2.3 Package Code + Dependencies

[`scripts/package_lambda.py`](../scripts/package_lambda.py):

```bash
.venv/Scripts/python.exe scripts/package_lambda.py
```

**要留意嘅陷阱:** 呢個 project 本機開發喺 Windows,但 Lambda 跑喺 Amazon Linux。直接 `pip install --target` 會攞返 Windows 專用嘅編譯版本(例如 `cryptography`、`cffi` 呢啲有 C extension 嘅 package),上到 Lambda 會即刻 `ImportError`。Fix 係逼 pip 攞 Linux wheel:

```
--platform manylinux2014_x86_64 --implementation cp --python-version 3.12 --only-binary=:all:
```

`pytest` 特登冇打包入去——佢淨係 dev/test 用,main.py/lambda_handler.py 運行時完全用唔著,冇必要塞落生產部署包度。

**Code review 時搵到嘅跟進問題:** 最初個 script 自己 hardcode 一份 `google-api-python-client==2.199.0` 等等嘅版本清單,同 `requirements.txt` 重複——第日 `requirements.txt` 升級版本,好易漏咗記得同步呢個 script,搞到部署去 Lambda 嘅版本同本機 test 緊嘅唔一致。改成一個 `_load_runtime_dependencies()` function,直接讀 `requirements.txt`,用一個 `DEV_ONLY_PACKAGES = {"pytest"}` set 排除唔要嘅 package,`requirements.txt` 變成單一嘅 source of truth,唔使再手動維護第二份清單。

### 2.4 開 Lambda Execution Role(要用 root)

Lambda function 本身執行 code 嗰陣,唔係用緊「你」嘅身份——佢用緊一個**獨立、屬於 Lambda 自己嘅身份**,要靠一個 IAM role 話俾 AWS 聽「Lambda 可以做啲咩」(例如寫 CloudWatch Logs)。

因為 `PowerUserAccess` 刻意唔包任何 IAM 操作,`yobi-analytics-cli` 呢個 CLI user 做唔到 `iam:CreateRole`,要換返用 root(Console 登入,唔係之前停用咗嗰條 key):

1. IAM → Roles → Create role
2. Trusted entity type:AWS service
3. Use case:Lambda
4. 掛 `AWSLambdaBasicExecutionRole`
5. Role name:`yobi-analytics-lambda-role`
6. Create role

### 2.5 開 Custom Policy,等 CLI User 可以用返呢個 Role

單單開咗個 role 仲未夠——之後要用 CLI 建立/更新 Lambda function 嗰陣,一樣要 `iam:PassRole` 呢個權限(將呢個 role 交俾 Lambda 用),但 `PowerUserAccess` 冇包埋呢個 action。

解決:開一條**淨係俾呢一個特定 role** 嘅窄 policy,而唔係擴大成個 user 嘅 IAM 權限:

1. IAM → Policies → Create policy → JSON tab

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ManageYobiLambdaExecutionRoleOnly",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:GetRole",
        "iam:AttachRolePolicy",
        "iam:PassRole"
      ],
      "Resource": "arn:aws:iam::189461315571:role/yobi-analytics-lambda-role"
    }
  ]
}
```

2. Policy name:`YobiLambdaRoleScopedAccess`
3. Create policy
4. IAM → User groups → `yobi-analytics-admins` → Permissions → Add permissions → Attach policies → 剔選 `YobiLambdaRoleScopedAccess`

🔴 **2026-09-05 CodeRabbit 搵到嘅 Critical 缺口(⚠️ 待實際喺 AWS 執行,呢份文件已經記錄低要點做):** 上面條 `iam:AttachRolePolicy` 冇限制邊條 policy 先俾 attach——即係話 `yobi-analytics-cli` 理論上可以將**任何** managed policy(包括 `AdministratorAccess`)attach 落 `yobi-analytics-lambda-role`,再叫 Lambda 用嗰個身份運行,變相繞過咗「Lambda role 應該收窄」呢個原意,係一條特權提升(privilege escalation)嘅路。修復方法係加一個 `iam:PolicyARN` condition,淨係俾實際用緊嗰條 policy 嘅 ARN:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ManageYobiLambdaExecutionRoleOnly",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:GetRole",
        "iam:PassRole"
      ],
      "Resource": "arn:aws:iam::189461315571:role/yobi-analytics-lambda-role"
    },
    {
      "Sid": "AttachOnlyTheRequiredManagedPolicy",
      "Effect": "Allow",
      "Action": "iam:AttachRolePolicy",
      "Resource": "arn:aws:iam::189461315571:role/yobi-analytics-lambda-role",
      "Condition": {
        "ArnEquals": {
          "iam:PolicyARN": "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
        }
      }
    }
  ]
}
```

呢個改動要去 IAM → Policies → `YobiLambdaRoleScopedAccess` → Edit policy 手動套用,唔會因為改咗呢份文件就自動生效——如果之後真係要幫呢個 role attach 多一條唔同嘅 managed policy,記得同步將條 ARN 加落 `ArnEquals` 度。

**點解要分開兩樣嘢,唔係淨係 `PowerUserAccess` 就夠:**

- `PowerUserAccess` 管嘅係「**你**(CLI user)可以喺 AWS 度做咩」,刻意唔包 IAM
- Role 管嘅係「**Lambda function 本身**可以做咩」,同你嘅權限完全獨立,係另一個身份
- Custom policy 補返「你」冇嘅一小塊 IAM 權,但淨係開一條窄縫(單一個 role),唔係成個 IAM 都開放

### 2.6 用 AWS CLI 開 Lambda Function

```bash
aws lambda create-function --function-name yobi-analytics-collector --runtime python3.12 --role arn:aws:iam::189461315571:role/yobi-analytics-lambda-role --handler lambda_handler.lambda_handler --zip-file fileb://build/lambda_deployment.zip --timeout 300 --memory-size 512 --region ap-northeast-1
```

Handler 格式係 `<檔名>.<function名>`——`src/lambda_handler.py` 入面個 `lambda_handler` function,所以係 `lambda_handler.lambda_handler`。IAM role 啱啱開好可能要等幾秒先生效,見到「role cannot be assumed」等一陣重試就得。

### 2.7 Set 環境變數——⚠️ Key 洩漏事故同教訓(**已修復,見底部**)

**呢步一定要自己喺 terminal 打,唔會假手於人:**

```bash
aws lambda update-function-configuration --function-name yobi-analytics-collector --region ap-northeast-1 --environment "Variables={YOUTUBE_API_KEY_SECRET_NAME=yobi-analytics/youtube-api-key,YOBI_DATA_DIR=/tmp}"
```

**事故記錄:** 第一次做呢步嗰陣,`update-function-configuration`/`get-function` 嘅 output **內建就會夾住個環境變數嘅真實值**,冇加任何過濾嘅話,個 command 自己就會將完整 key 印晒出嚟。連續兩次唔為意咁將成份 output 貼咗去對話框,導致條 key 曝光兩次,要分別去 Google Cloud Console 換過新 key。

**Fix / 以後守則:**

- 之後所有會touch到 `Environment` 呢個 field 嘅 command,查詢嗰陣一律加 `--query` 明確揀返需要嘅 field,將 `Environment` 剔出結果結構之外,例如:
  ```bash
  aws lambda get-function --function-name yobi-analytics-collector --region ap-northeast-1 --query "Configuration.{State:State,LastUpdateStatus:LastUpdateStatus,Timeout:Timeout,MemorySize:MemorySize}"
  ```
- `--query` 嘅過濾發生喺 AWS CLI **自己部機度**(用 jmespath library),原始 response 有 key,但經過呢個 query 建構出嚟嘅新 object 結構上就唔會有 `Environment` 呢個 key,唔係「碰彩冇揀中」。
- `update-function-configuration` 呢類**寫入**指令(唔止查詢),output 一樣會 echo 返個新值,一律唔好貼、自己喺 terminal 睇完就算。
- 換 key 唔使驚會整壞/整封 Google 帳戶——開/刪 API key 係正常帳戶管理操作,冇「換得太密會封鎖」嘅機制,一個 project 預設可以開到幾百條。

✅ **已修復(Build Day 2,2026-09-05)**:`YOUTUBE_API_KEY` 已經搬去 **AWS Secrets Manager**(secret name `yobi-analytics/youtube-api-key`),`yobi-analytics-collector` 嘅環境變數而家淨係存 `YOUTUBE_API_KEY_SECRET_NAME` 呢個 secret 名(唔係真正個 key),runtime 由 [`src/config.py`](../src/config.py) 嘅 `get_api_key()` 向 Secrets Manager 攞返真正個值,cache 喺 module 層面。`yobi-analytics-lambda-role` 加咗一條新嘅 inline policy `YobiSecretsAccess`,淨係俾 `secretsmanager:GetSecretValue`,鎖死喺呢一個 secret 嘅 ARN。即使而家 `Environment` 俾人查到都唔會再見到明文 key。本地開發唔受影響,`.env` 嘅 `YOUTUBE_API_KEY` 繼續做 fallback。

### 2.8 手動 Invoke——CLI Read-Timeout 陷阱

```bash
aws lambda invoke --function-name yobi-analytics-collector --region ap-northeast-1 --cli-read-timeout 950 build/lambda_invoke_output.json
```

**陷阱:** `aws lambda invoke` 預設係同步 call,CLI 自己有一個**client-side read timeout**(遠遠短過 Lambda function 本身嘅執行上限)。第一次唔知情冇加 `--cli-read-timeout`,個 collection job 真係跑咗耐過 CLI 肯等嘅時間,CLI 直接 `Read timeout` 放棄,睇落好似完全冇反應/失敗,但**Lambda 喺 AWS 嗰邊其實仍然照跑,CloudWatch 一樣照寫 log**——CLI 等唔切同「Lambda 冇執行」係完全兩件事。

**Fix:** 加 `--cli-read-timeout`,設耐過 Lambda function 本身嘅 timeout(例如 function timeout 900 秒,CLI 就設 950 秒),等 CLI 肯乖乖等到真結果先返嚟。

**呢個問題喺 2.4(EventBridge)之後唔會再出現**——EventBridge trigger Lambda 唔係同步 call,唔會有「CLI 坐喺度等」呢回事,所以之後排程自動執行,完全唔受呢個 client-side timeout 影響。CloudWatch logging 本身係無條件、自動嘅 platform 行為,唔需要靠邊個「等緊」先會發生。

### 2.9 真實撞到嘅 Timeout:調大 Timeout / Memory

第一次成功 invoke 之前,曾經真係俾 Lambda 自己嘅執行上限 kill 咗:

```json
{"errorType":"Sandbox.Timedout","errorMessage":"...Task timed out after 300.00 seconds"}
```

即係話成個 collection job(discovery 73 個 creator + statistics collection)喺 Lambda 環境入面,真係耐過 5 分鐘先跑得完——可能係 cold start、又或者 512MB 記憶體對應嘅 CPU 太弱。

**Fix:**

```bash
aws lambda update-function-configuration --function-name yobi-analytics-collector --region ap-northeast-1 --timeout 900 --memory-size 1024
```

`--timeout 900` 係 Lambda 容許嘅絕對上限(15 分鐘)。`--memory-size` 加大,CPU 配額都會跟住加大(Lambda 嘅 CPU 配額同記憶體大細掛鈎)。改完之後,一樣要用 `--query` 確認 `LastUpdateStatus` 變返 `Successful` 先再 invoke——喺更新仲 `InProgress` 嗰陣就 invoke,會直接俾 Lambda 拒絕。

### 2.10 確認 CloudWatch Logs 乾淨

唔使成段 log 貼晒出嚟睇,用 `filter-log-events` 淨係搜返想確認嘅字眼:

```powershell
$startTime = [DateTimeOffset]::UtcNow.AddMinutes(-10).ToUnixTimeMilliseconds()
aws logs filter-log-events --log-group-name /aws/lambda/yobi-analytics-collector --region ap-northeast-1 --start-time $startTime --filter-pattern "not valid"
```

`events: []` 淨係代表「呢個 filter pattern、呢個時間窗入面搵唔到相關字眼」,**唔代表呢次 invocation 一定乾淨**——`--filter-pattern` 淨係搵緊一個特定字眼(例如 `"not valid"`),搵唔到唔代表冇 `FunctionError`/`Task timed out`/`Unhandled error` 呢類其他形式嘅問題,亦都唔代表個時間窗冚啱咗真正嗰次 invocation。要真正確認一次 invoke 乾淨,仲要:1) 睇返 `aws lambda invoke` 自己個 response(有冇 `FunctionError` 欄位),2) 用 `--filter-pattern "REPORT"` 或者直接攞成段 log 睇下有冇 `Status: timeout`/`Status: error` 呢類字眼,3) 確認個時間窗真係覆蓋咗嗰次 invocation 嘅實際區間。`-10` 分鐘嘅選擇係為咗啱啱好覆蓋返「最新一次完整 run」嘅時間範圍——太短會漏咗 run 開頭部分,太長就會撈埋更早、已經處理過嘅舊 run(例如之前撞 timeout 嗰次)嘅 log,混淆判斷。

呢個 command 純粹讀 CloudWatch 已經存低嘅 log,唔會再打 YouTube API,唔會再食 YouTube quota。

---

## 2.2 完成確認

Definition of Done 全部達成:

- [x] Python code packaged(`scripts/package_lambda.py`)
- [x] AWS CLI 可以部署/更新 Lambda(`create-function`、`update-function-configuration`)
- [x] Lambda 成功執行(`StatusCode: 200`,冇 `FunctionError`)
- [x] 手動 invoke work(排除 CLI read-timeout 假象之後確認)
- [x] CloudWatch 有清晰、有用嘅 log(真實 video 資料,冇殘留 error)

**更新(2026-09-05):2.3(DynamoDB Storage)同 2.4(EventBridge Daily Schedule)都已經完成部署,唔再係「之後先做」嘅未來工作。** `src/dynamodb_store.py` 早已實現並且部署緊(`YOBI_STORAGE_BACKEND=dynamodb`),8 張生產表(`YobiVideoMaster`/`YobiSnapshots` 等)全部已建立,`yobi-analytics-collector` 亦已經完全靠 DynamoDB 運作,唔再用返呢節講嘅 `/tmp` 過渡方案。EventBridge 排程方面,已經有 6 條實際運行緊嘅 schedule:主收集(18:00 JST)、discovery-only(00:00 JST)、trending precompute 三條(19:00/20:00/21:00 JST,分別對應 1d/7d/30d 三個 period)、notification dispatch(每 15 分鐘)。詳情見 [`Roadmap.md`](../Roadmap.md)。
