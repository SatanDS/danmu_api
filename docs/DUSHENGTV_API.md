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

`title` 使用劇名而非單集名稱。`type` 支援 `Movie`、`Episode`、`local`；`Episode` 必須提供季數與集數。本地影片 `local` 的檔名若含 `S02E04`，可解析季集。特殊季或第 0 集返回無可用結果，避免誤配到 S01E01。劇集首播年份不限制後續季的匹配。

電影優先使用 Emby 的外部編號確認作品，例如：

```json
{"title":"老枪","type":"Movie","year":2024,"providerIds":{"Imdb":"tt29308412"}}
```

`providerIds` 支援 `Douban`、`Imdb`、`Tmdb`，鍵名不分大小寫，值為編號字串，不接受 URL。優先順序為豆瓣 ID、IMDb ID、TMDB ID；IMDb 經豆瓣的 ID 對照接口定位作品，TMDB 需服務已配置有效的 TMDB 憑據，再取得 IMDb ID。豆瓣資料確認 ID 與電影類型後，只使用該作品關聯的播放平台連結取得彈幕。標題翻譯或首映／公映年份差異不會改變這條身份對應關係。

已提供 ID 但查不到作品、沒有對應的播放平台或沒有彈幕時，返回「無彈幕匹配」，不改查同名電影。沒有外部 ID 時，電影僅使用精確片名／別名、電影類型與相同年份的候選；未提供年份且候選有不同年份時不自動選擇。不使用相鄰年份猜測。劇集 ID 不能直接當作某一季的豆瓣 ID，目前仍依明確季集匹配。

成功結果：

```json
{
  "available": true,
  "comments": [{"time": 1.25, "mode": 1, "color": "#ffffff", "text": "彈幕內容"}],
  "match": {"episodeId": 42, "animeTitle": "劇集名稱", "episodeTitle": "第4集"}
}
```

`time` 單位是秒；`mode` 為 1 滾動、4 底部、5 頂部；`color` 為 RGB 十六進位字串。依時間排序，最多 50,000 條、約 12 MiB，單條文字最多 300 個 UTF-16 code units。前端應將文字當成純文字顯示。

當 `SOURCE_ORDER` 含 `local` 時，無外部電影 ID 的請求可優先使用已上傳、標題及季集吻合的本地彈幕；不會將整部作品的彈幕套到任意一集。有外部電影 ID 時，不使用僅按片名標註的本地資源覆蓋 ID 對應結果；播放器仍可手動匯入本地彈幕。上游匹配必須提供唯一、有效的 episodeId，不跟隨請求傳來的媒體 URL。

無結果為 HTTP 200、`available:false`、`comments:[]` 和 `message:"無彈幕匹配"`；供診斷的 `reason` 為 `NO_MATCH`、`TYPE_MISMATCH` 或 `EMPTY_COMMENTS`。其他狀態：400 資料無效、401 服務 Token 不正確、405 方法錯誤、413 超過 16 KiB 請求限制、415 非 JSON、429 忙碌、502 來源錯誤、503 未配置、504 超時。Bot 會把上游服務憑據錯誤映射為 502，避免讓客戶端誤判 TG 登入過期。

適配器最多同時執行 4 個不同影片請求，相同進行中請求共用工作；每次最多等待 60 秒。Bot 另限制每位 TG 使用者每分鐘 12 次。對外域名入口仍驗證 Bearer，同時透過 Bot 現有 CDN 節點清單檢查回源連接；兩種驗證分別負責呼叫權限與節點權限。

Docker／Node 22.13+ 預設將本接口成功取得的非空彈幕保存至本機 SQLite，所有使用者共用同作品／同集內容，容器重建後仍有效。`DUSHENGTV_CACHE_DAYS` 可設 7–30 天（預設 14），與舊接口的分鐘快取獨立。已確認的電影外部 ID 不受標題別名或年份表述差異影響；不同外部 ID 組合不擅自合併。無 ID 的電影仍區分精確片名與年份，劇集仍區分劇名、外部 ID、季、集。來源、匹配規則及輸出設定變動會使用新快取鍵。本地上傳每次優先檢查，不會被舊的遠端快取遮蓋。

有資料庫快取的成功結果可多帶 `cache` 欄位，例如 `{"status":"hit","stale":false,"storedAt":"2026-10-05T00:00:00.000Z"}`。`status` 為 `miss`（首次抓取並保存）、`hit`、`refreshed` 或 `stale`。過期後由下一次訪問觸發一次共享更新；429、超時、空結果或無匹配都不覆蓋既有成功內容，而以 HTTP 200、`available:true` 回傳舊彈幕並標記 `cache.stale:true`。`cache.reason` 為 `REFRESH_FAILED`、`REFRESH_TIMEOUT`、`REFRESH_UNAVAILABLE`、`REFRESH_COOLDOWN` 或 `SERVICE_BUSY`。更新失敗至少冷卻 60 秒，避免每位使用者都重試。首次沒有成功快取時保留原本無匹配／錯誤語義。資料庫寫入失敗仍回傳本次成功取得的內容，不會刪除舊資料庫自行重建。Worker、Forward 及不支援 SQLite 的 Node 版本維持即時查詢。

快取只儲存作品彈幕、匹配資料、雜湊鍵與時間，不保存 TG 使用者、裝置、Token 或 IP。容量與清理、備份方法見 Docker 教學。這能減少重複採集；首次觀看大量不同作品仍可能受到來源站頻率限制。

部署與驗收見 [Docker 教學](DUSHENGTV_DOCKER.md)。
