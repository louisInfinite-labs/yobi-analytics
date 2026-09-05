# $2 通知 + $5 自動停 API 機制(2026-09-05)

記錄今晚喺 AWS Console 手動設好、已測試成功嘅支出防呆機制,對應 [`Roadmap.md`](../Roadmap.md) 5.3(Cost and Abuse Containment)。同 [`aws-setup.zh-TW.md`](aws-setup.zh-TW.md) 一樣嘅慣例:**呢份文件淨係記錄已經喺 Console 度做咗嘅設定,唔係「跑呢份文件就會生效」**——如果之後要喺另一個帳戶/環境重做,要人手跟住以下步驟逐步喺 Console 度做,或者用文件入面附嘅 CLI 指令。

---

## 背景

查證咗 `yobi-analytics-monthly`($5/月)呢個 AWS Budget 原本冇綁任何 Budget Action——爆咗預算都唔會自動停任何嘢,淨係得 email。而 AWS Budgets 原生嘅 Action 類型(`APPLY_IAM_POLICY`、`APPLY_SCP_POLICY`、`RUN_SSM_DOCUMENTS`)入面,`RUN_SSM_DOCUMENTS` 淨係支援停 EC2/RDS,呢個 project 全 serverless,冇一款原生 Action 啱用。所以用咗 AWS 官方建議嘅標準做法:**Budget 門檻 → SNS → 自訂 Lambda 執行想要嘅停止動作**。

⚠️ **呢個係 best-effort 嘅延遲觸發,唔係一個即時嘅硬上限**:AWS Budgets 睇嘅係實際帳單數據,一日更新幾次、有幾個鐘嘅 lag,即係話真正觸發嗰陣,實際使費可能已經超咗 $5 少少;而且觸發之後 `yobi-analytics-collector`/`yobi-analytics-notification-dispatcher` 同 DynamoDB 依然會繼續產生正常費用(見「已知限制」)。呢個機制防嘅係「暴增到失控」,唔係保證使費永遠停喺 $5 嗰一刻。

## 架構

```
yobi-analytics-monthly(Budget)
  ├─ 20%($1)  → email                          [Phase 2.1 已有]
  ├─ 40%($2)  → email                          [今晚新增,純通知]
  └─ 100%($5) → email + SNS(yobi-analytics-emergency-stop-topic)
                                ↓
                    yobi-analytics-emergency-stop(Lambda)
                                ↓
              lambda:PutFunctionConcurrency(yobi-analytics-api, 0)
                                ↓
                  yobi-analytics-api 即時被完全 throttle
```

`yobi-analytics-collector`、`yobi-analytics-notification-dispatcher` 唔受影響,繼續正常運作——呢個機制淨係閂 public API,唔停資料收集,對應 Roadmap 5.3 講嘅「Incident switch」概念。

## 已建立嘅資源

| 資源 | 名稱 / ARN |
|---|---|
| SNS topic | `arn:aws:sns:ap-northeast-1:189461315571:yobi-analytics-emergency-stop-topic` |
| IAM role | `yobi-analytics-emergency-stop-role` |
| Lambda function | `yobi-analytics-emergency-stop`(region ap-northeast-1,Python 3.13) |

### IAM role 嘅 inline policy(`EmergencyStopPermissions`)

跟返 [aws-setup.zh-TW.md:193-255](aws-setup.zh-TW.md) 已有嘅 least-privilege pattern——淨係俾呢個 role 兩樣權:改 `yobi-analytics-api` 一個 function 嘅 concurrency,同寫自己嘅 CloudWatch log。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowStopYobiApi",
      "Effect": "Allow",
      "Action": "lambda:PutFunctionConcurrency",
      "Resource": "arn:aws:lambda:ap-northeast-1:189461315571:function:yobi-analytics-api"
    },
    {
      "Sid": "AllowCreateLogGroup",
      "Effect": "Allow",
      "Action": "logs:CreateLogGroup",
      "Resource": "arn:aws:logs:ap-northeast-1:189461315571:*"
    },
    {
      "Sid": "AllowOwnLogStream",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:ap-northeast-1:189461315571:log-group:/aws/lambda/yobi-analytics-emergency-stop:*"
    }
  ]
}
```

### Lambda handler

實際部署方式:直接喺 Lambda console 嘅 inline code editor 貼入,檔名/handler 維持 Console 預設嘅 `lambda_function.py` / `lambda_function.lambda_handler`,冇用 `scripts/package_lambda.py` 嗰套部署流程(呢個 function 冇任何 `src/` 依賴,淨係用 Lambda runtime 自帶嘅 `boto3`)。程式碼備份喺 [`src/emergency_stop_handler.py`](../src/emergency_stop_handler.py),兩者要手動保持一致——改咗其中一邊要記得同步另一邊。**呢度冇任何自動化去偵測兩邊走樣**,即係話 repo 度 review 過嘅版本,可能同實際跑緊嗰份唔一致而冇人發現。之後改呢個 handler,建議喺改完 repo 版本之後,順手貼一次去 Console 再 Deploy,確保兩邊同步,唔好淨係改一邊。

### Trigger

Lambda 嘅 **Add trigger → SNS** 揀返上面個 topic,呢一步 Console 自動處理咗 SNS 訂閱同 Lambda resource-based permission,冇再額外手動加。

### Budget notifications(最終狀態,3 個門檻)

| Alert | Threshold | Trigger | 訂閱者 |
|---|---|---|---|
| #1 | 20%($1) | Actual | email |
| #2 | 100%($5) | Actual | email + SNS(`yobi-analytics-emergency-stop-topic`) |
| #3 | 40%($2) | Actual | email |

## 已完成嘅測試(2026-09-05)

喺 SNS console 手動 **Publish message** 去個 topic(唔涉及真實使費),確認:
- `aws lambda get-function-concurrency --function-name yobi-analytics-api --region ap-northeast-1` 顯示 `ReservedConcurrentExecutions: 0` ✅
- 測試完已經人手復原(Lambda console → Configuration → Concurrency → Edit → **Use unreserved account concurrency** → Save),`get-function-concurrency` 確認返冇任何 reserved 設定 ✅

**未測試嘅一段**:Budget 監測到真實 100% 支出 → 自動 publish 去 SNS 呢一步(冇做,因為要真係使到 $5 先會自然觸發)。呢個係 AWS 原生成熟功能,理論上唔應該有問題:
- SNS topic policy 要畀 `budgets.amazonaws.com` 有 `sns:Publish` 權限——Console 嘅 Lambda **Add trigger → SNS** 步驟已經自動處理咗呢個授權,唔使再手動加
- Topic 同 budget 使緊同一個帳戶(`189461315571`),冇跨帳戶問題
- Lambda 嘅 SNS 訂閱狀態已經確認係 `Confirmed`(見 SNS console 嘅 Subscriptions 分頁)

即係已知條件都啱,但**冇實際觸發過嚟確認**。想連呢段都驗證埋,可以做呢個安全測試:暫時將 Alert #2(100%/$5)嘅 threshold 數值改細(例如由 `100` 改做細過依家實際使費百分比嘅數,例如 `1`),等 Budget 下次刷新數據(幾個鐘之內)誤判超標、自然推去 SNS,確認 `yobi-analytics-api` concurrency 變 0 之後,即刻將門檻改返做 `100`。

## 人手復原步驟(觸發之後)

確認 dev 問題已經修好先做,**唔設自動重開**:

1. Lambda console → `yobi-analytics-api` → Configuration → Concurrency → Edit
2. 揀 **Use unreserved account concurrency** → Save

或者 CLI:
```bash
aws lambda delete-function-concurrency --function-name yobi-analytics-api --region ap-northeast-1
```

⚠️ 呢個復原去嘅係**「unreserved account concurrency」**(冇任何 reserved 設定),因為呢個係 `yobi-analytics-api` 依家實際嘅正常狀態(reserved concurrency=10 嗰個計劃仲未做到,見 [`2026-09-05-phase5.3-handoff-and-pr-review-loop.md`](2026-09-05-phase5.3-handoff-and-pr-review-loop.md) 嘅 quota 卡住問題)。**一旦嗰個 quota 批咗、reserved=10 正式套用做標準狀態之後,呢一步要改做「重新設 reserved=10」,唔可以再復原去 unreserved**——到時記得同步更新呢份文件。

## 已知限制

- 淨係防到「public API 呢邊爆錢」,如果係 `yobi-analytics-collector`/`yobi-analytics-notification-dispatcher` 本身出 bug(例如死循環狂寫 DynamoDB),呢個機制唔會停到嗰兩個 function
- 觸發之後唔會自動復原,要人手處理
- Budget → SNS 呢段冇實測過(見上面「已完成嘅測試」)
