# DuShengTV 適配接口

客戶端透過 Bot 的 `POST /api/dushengtv/v1/providers/danmaku` 和現有 TG 會話取得彈幕。Bot 驗證帳號與装置後，再以服務 Token 呼叫以下接口；服務 Token 不存入客戶端。

```http
POST /api/v1/dushengtv/danmaku
Authorization: Bearer <TOKEN>
Content-Type: application/json
```

電影請求：

```json
{"title":"電影名稱","type":"Movie","year":2026}
```

劇集請求：

```json
{"title":"劇集名稱","type":"Episode","season":2,"episode":4}
```

`title` 使用劇名而非單集名稱。`type` 支援 `Movie`、`Episode`、`local`；`Episode` 必須提供季數與集數。本地影片 `local` 的檔名若含 `S02E04`，可解析季集。特殊季或第 0 集返回無可用結果，避免誤配到 S01E01。電影年份可用於區分同名作品；劇集首播年份不限制後續季的匹配。`providerIds` 可由 Bot 傳遞，目前適配器以標題、類型與季集匹配。

成功結果：

```json
{
  "available": true,
  "comments": [{"time": 1.25, "mode": 1, "color": "#ffffff", "text": "彈幕內容"}],
  "match": {"episodeId": 42, "animeTitle": "劇集名稱", "episodeTitle": "第4集"}
}
```

`time` 單位是秒；`mode` 為 1 滾動、4 底部、5 頂部；`color` 為 RGB 十六進位字串。依時間排序，最多 50,000 條、約 12 MiB，單條文字最多 300 個 UTF-16 code units。前端應將文字當成純文字顯示。

當 `SOURCE_ORDER` 含 `local` 時，優先使用已上傳、標題及季集吻合的本地彈幕；不會將整部作品的彈幕套到任意一集。上游匹配必須提供唯一、有效的 episodeId，不跟隨請求傳來的媒體 URL。

無結果為 HTTP 200、`available:false` 和可見 `message`。其他狀態：400 資料無效、401 服務 Token 不正確、405 方法錯誤、413 超過 16 KiB 請求限制、415 非 JSON、429 忙碌、502 來源錯誤、503 未配置、504 超時。Bot 會把上游服務憑據錯誤映射為 502，避免讓客戶端誤判 TG 登入過期。

適配器最多同時執行 4 個不同影片請求，相同進行中請求共用工作；每次最多等待 60 秒。Bot 另限制每位 TG 使用者每分鐘 12 次。對外域名入口仍驗證 Bearer，同時透過 Bot 現有 CDN 節點清單檢查回源連接；兩種驗證分別負責呼叫權限與節點權限。

部署與驗收見 [Docker 教學](DUSHENGTV_DOCKER.md)。
