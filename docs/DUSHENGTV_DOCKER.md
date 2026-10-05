這份流程使用已安裝 Docker 的 Debian 12 伺服器，彈幕服務與使用 `network_mode: host` 的 DuShengTV Bot 位於同一台主機，網域為 `danmu.dusheng.lol`，對外連線由遠端 DuShengCDN 節點反向代理。

Bot 透過 `http://127.0.0.1:9321` 取得彈幕，DuShengTV 客戶端繼續使用 Bot 的接口。即使已配置網域，Bot 仍使用本機位址，以避開 CDN 的回源超時及公網連線依賴。

此部署統一放在 `/opt/danmu`，從本倉庫建置映像；設定保存在 `/opt/danmu/config/.env`，持久化資料保存在 `/opt/danmu/data/`。下方彈幕服務命令均在 `/opt/danmu` 執行。只將 9321 映射到主機的 `127.0.0.1`。Bot 的本機連線不需要網域或另外開放防火牆端口；CDN 的對外接口按下方的 TLS 入口與 Bot 即時 IP 授權設定。

**已有部署：升級共享彈幕資料庫快取。**

在伺服器執行：

```bash
cd /opt/danmu
git pull --ff-only origin codex/dushengtv-docker
docker compose build --pull danmu-api
docker compose up -d --no-deps danmu-api
curl --fail http://127.0.0.1:9321/healthz
```

原有 `config/.env`、Bot Token 和 `data/` 掛載保持有效，無須重新初始化或清空資料。首次成功抓取後會建立 `/opt/danmu/data/dushengtv-danmaku.sqlite`（容器內 `/app/.cache/dushengtv-danmaku.sqlite`）。Docker 使用最新 Node 22 映像，內建 SQLite 需要 Node 22.13+；不支援時保留原即時查詢行為並在日誌提示，不會刪除既有資料庫。

播放一部取得遠端彈幕的影片後，可只讀檢查資料庫條目數和容量，不會輸出 Token、影片名稱或彈幕內容：

```bash
cd /opt/danmu
docker compose exec -T danmu-api node --input-type=module < scripts/inspect-dushengtv-cache.mjs
```

正常會顯示 `exists:true`、`entries` 大於 0。同一影片再次播放不會再新增一份條目；只有本地匯入或尚未匹配成功時可以仍是 0。

在管理頁的「快取配置」或 `/opt/danmu/config/.env` 可調整以下設定；檔案設定支援熱更新，無須重啟：

```dotenv
DUSHENGTV_CACHE_ENABLED=true
DUSHENGTV_CACHE_DAYS=14
DUSHENGTV_CACHE_MAX_MB=512
```

- `DUSHENGTV_CACHE_DAYS`：7–30 天，預設 14。修改後立即按新天數判定既有資料是否過期。
- `DUSHENGTV_CACHE_MAX_MB`：內容容量 64–4096 MiB，預設 512。超過時按最後訪問時間淘汰；SQLite 索引及 WAL 另需空間。資料頁會重用，定期清理空閒頁。
- `DUSHENGTV_CACHE_ENABLED=false`：停用此快取但保留資料庫，重新啟用可繼續使用。與 `LOCAL_CACHE_ENABLED`、`COMMENT_CACHE_MINUTES` 及 `COMMENT_CACHE_MIN_COUNT` 獨立。

同作品／同集由所有使用者共享。有效期內直接讀本地資料；到期後首次訪問才向來源更新，相同作品的併發訪問共用更新。只有非空成功結果才以 SQLite 交易替換舊資料；來源限頻、超時、無匹配或空結果會繼續使用舊的成功彈幕，並回傳 `cache.stale=true`。失敗後 60 秒內不重複更新。沒有舊快取時仍顯示「無彈幕匹配」或原來的服務錯誤。7–30 天決定刷新週期，到期本身不刪除成功內容；只有容量不足時按最後訪問時間淘汰，正在更新的舊結果受保護。每小時維護回收空閒資料頁，不會定時全庫向來源採集。

資料庫鍵區分外部 ID、電影／劇集與季集，不降低原本的作品匹配要求。來源及匹配／輸出規則變更會使用新鍵，本地手動上傳仍即時優先。保存內容不包含使用者、裝置、Token 或 IP。這項快取減少重複採集，不能保證第一次批量抓取不同作品不受來源限頻。

管理頁既有「清除快取」只清理其列出的記憶體／搜尋／ID 資料，**不刪除此 SQLite 資料庫**。需要備份或完全重建此庫時，先停止彈幕容器；不要在運行中只複製主檔而漏掉 WAL：

```bash
cd /opt/danmu
docker compose stop danmu-api
cache_backup_dir="backups/danmaku-$(date +%Y%m%d-%H%M%S)"
mkdir -p -- "$cache_backup_dir"
for cache_file in data/dushengtv-danmaku.sqlite data/dushengtv-danmaku.sqlite-wal data/dushengtv-danmaku.sqlite-shm; do
  if [ -f "$cache_file" ]; then cp -p -- "$cache_file" "$cache_backup_dir/"; fi
done
docker compose start danmu-api
```

若明確要清空，完成備份後再次 `docker compose stop danmu-api`，只刪除上述三個 `data/dushengtv-danmaku.sqlite*` 精確檔案，再 `docker compose start danmu-api`。不要刪除整個 `data/`，其中還有本地上傳和其他持久資料。

**第一步：確認 Debian 12 上的 Docker 和端口。**

在伺服器 SSH 終端執行：

```bash
cat /etc/os-release
uname -m
docker --version
docker compose version
docker info --format '{{.Architecture}}'
ss -lnt '( sport = :9321 )'
```

Docker Engine 已安裝，請確認 `docker compose version` 顯示可用的 Compose v2。若目前帳號沒有 Docker 權限，使用具有權限的管理帳號執行。若 9321 已被其他服務占用，先解決端口衝突。

Git、OpenSSL 或 curl 缺少時，可在 Debian 12 執行：

```bash
sudo apt-get update
sudo apt-get install -y git openssl curl python3
```

**第二步：克隆 DuShengTV 分支。**

```bash
mkdir -p /opt/danmu
cd /opt/danmu
git clone --branch codex/dushengtv-docker --single-branch https://github.com/SatanDS/danmu_api.git .
git rev-parse --short HEAD
```

若已有克隆，請先保存自己的修改，再切換到 `codex/dushengtv-docker`；不要用這份流程覆蓋既有設定。

**第三步：初始化私人設定與資料目錄。**

```bash
bash scripts/init-dushengtv.sh
```

腳本使用 OpenSSL 產生不同的隨機 `TOKEN` 和 `ADMIN_TOKEN`，將 `config/.env` 權限設為 600、`config/` 和 `data/` 設為 700。重複執行會保留原有檔案內容和令牌。

初始來源包含 `local,douban,360,tencent,youku,iqiyi,imgo,bilibili`，搜尋和彈幕記憶體快取為 10 分鐘，日誌級別為 `warn`。`REMEMBER_LAST_SELECT=false` 避免 Bot 共用 IP 的選擇影響其他觀眾。`local` 用於已上傳的本地彈幕及離線驗收；其他來源能否連線取決於伺服器所在區域。

若腳本提示保留原有 `config/.env`，請以編輯器確認已有至少 32 字元的自訂 `TOKEN`、獨立的 `ADMIN_TOKEN`，且 `SOURCE_ORDER` 包含 `local`。舊的預設 `TOKEN=87654321` 允許匿名呼叫舊接口，不適合這份部署；DuShengTV 接口會拒絕預設或過短的 token。可用 `openssl rand -hex 32` 分別產生替代值。設定檔不是 Shell 腳本，請不要以 `source` 或 `eval` 載入。

**第四步：建置並啟動。**

```bash
docker compose config --quiet
docker compose build --pull
docker compose up -d --wait --wait-timeout 120
docker compose ps
```

映像名稱是 `dushengtv/danmu-api:local`，由當前分支建置；Dockerfile 使用已提交的 `package-lock.json` 安裝依賴。第一次建置需要下載 Node 基礎映像與 npm 套件。

Compose 掛載 `./config:/app/config` 及 `./data:/app/.cache`。本機快取會保存劇集／彈幕 ID 對照、收藏、偏好和本地彈幕檔案；短期搜尋結果與彈幕內容快取會在重啟時清空。通常不需要另外部署 Redis。

**第五步：驗證健康狀態與本地彈幕。**

```bash
curl --fail --silent --show-error http://127.0.0.1:9321/healthz
docker compose logs --tail=100 danmu-api
```

健康接口應回傳 `{"status":"ok"}`。它只驗證 HTTP 服務存活，不需要 token，也不會存取外部彈幕源。Compose 的 `healthy` 同樣代表此檢查通過。

本地端到端驗收方式見 `scripts/smoke-dushengtv.mjs`：

```bash
docker compose exec -T danmu-api node --input-type=module < scripts/smoke-dushengtv.mjs
```

這個檢查會建立帶隨機名稱的本地測試彈幕、透過 DuShengTV 接口讀取、檢查內容，再刪除測試資源。它在容器內讀取設定，不會輸出令牌，不需要宿主機安裝 Node.js，也不會呼叫外部彈幕源。

**第六步：接上同主機的 DuShengTV Bot。**

將 Bot 的部署環境設為：

```dotenv
TGBOT_DANMU_API_URL=http://127.0.0.1:9321
TGBOT_DANMU_API_TOKEN=<config/.env 裡的 TOKEN 值>
```

URL 只填服務基底，不加 `/{TOKEN}` 或 `/api/v1/dushengtv/danmaku`。Bot 使用 `Authorization: Bearer <TOKEN>` 呼叫 `POST /api/v1/dushengtv/danmaku`。`ADMIN_TOKEN` 只供管理操作，不填入 Bot，也不要放進網頁程式碼。

在伺服器的 Bot 倉庫目錄保存好自己的程式修改後，更新並重建 `embyboss`：

```bash
git pull --ff-only origin master
docker compose build embyboss
docker compose up -d --no-deps --force-recreate embyboss
```

最新 `master` 包含彈幕轉發和下方的即時 CDN IP 授權接口。詳見 [Bot 彈幕部署文件](https://github.com/SatanDS/Sakura_embyboss/blob/master/docs/DUSHENGTV_DANMAKU.md)。`tv-api.dusheng.lol` 若也經 CDN，將該連線的回源讀取超時設為至少 75 秒，建議 120 秒，再發布並確認 Agent 版本；Bot 到彈幕服務仍走本機，不經 CDN。

這裡的 `127.0.0.1` 依賴 Bot 使用主機網路。如果日後把 Bot 改成一般 Docker bridge 網路，請將兩個服務接到同一 Docker 網路，並改用容器服務名稱；容器內的 `127.0.0.1` 只代表自己。

**管理與調整。**

直接修改 `config/.env` 後，服務會重新載入設定；Compose 固定主服務在容器內使用 9321。檔案設定若同時存在於容器的環境變數中，環境變數具有較高優先級，因此 Compose 沒有重複注入 token 或来源設定。

需要開啟管理頁時，可在自己的電腦建立 SSH 通道：

```bash
ssh -N -L 19321:127.0.0.1:9321 <SSH使用者>@<伺服器位址>
```

然後在自己電腦的瀏覽器打開 `http://127.0.0.1:19321/<ADMIN_TOKEN>/`。管理頁只經 SSH 通道使用，CDN 不轉發管理頁、舊的 token 路徑接口或 5321 代理端口。

**`danmu.dusheng.lol` 的 CDN 回源。**

先完成前六步，讓 Bot 使用本機彈幕接口。對外網域是額外入口；即使 CDN 或憑證尚未設定，Bot 的本機連線仍可使用。

CDN 節點位於遠端，因此使用 `compose.cdn.yaml` 和 `deploy/nginx-cdn-origin.conf` 建立獨立 TLS 回源入口。Nginx 容器使用主機網路，只監聽 9443，向 `127.0.0.1:9321` 轉發彈幕請求，向同機 Bot 驗證 CDN 節點 IP。管理站點與 5321 不對外轉發。

來源 IP 判斷直接復用 Bot 已維護的 `trusted_proxy_cidrs`，每次請求即時查詢。無需手填第二份白名單、匯出快照或輪詢；在 Bot 管理面板成功更新 CDN IP 清單後，下一個請求就會生效。空清單、無效清單或未命中的 IP 都會拒絕；Bot 無法連線時也拒絕回源。

Nginx 只轉發以下兩條精確路徑，其餘路徑一律 404：

| 對外接口 | 允許方法 | 用途 |
| --- | --- | --- |
| `/api/v1/dushengtv/danmaku` | POST | 保留呼叫者的 `Authorization: Bearer <TOKEN>` |
| `/healthz` | GET、HEAD | 經授權 CDN 節點公開的健康檢查，不需要 TOKEN |

先更新並啟動已提供 `/emby/cdn_origin` 接口的 Bot；其 API 設定需為 `api.status=true`，且能經 `127.0.0.1:<api.http_port>` 連線，預設端口為 8838。此部署支援 `api.http_url` 為 `127.0.0.1`、`localhost` 或 `0.0.0.0`；推薦沿用 loopback。Bot 的 `api.line_report_token` 已用於內部鑑權，這裡直接沿用，不重新產生或覆寫。

在源站的 `/opt/danmu` 執行，將 Bot 設定路徑換成實際宿主機檔案路徑；目前帳號需要讀取該檔案的權限：

```bash
bash scripts/prepare-cdn-origin.sh
python3 scripts/configure-cdn-origin.py --bot-config /實際Bot目錄/config.json
ss -lnt '( sport = :9443 )'
```

準備腳本只建立私人的設定和憑證目錄。Python 腳本檢查 API 已啟用、讀取現有 `api.line_report_token` 與 `api.http_port`，寫入權限 600 的 `config/cdn-auth.env`，不輸出令牌、不修改 Bot 設定，也不複製 CDN IP。Compose 只載入這兩個必要值，不將完整 Bot 設定檔掛進 Nginx。Python 使用標準庫，不需安裝額外套件。

Nginx 的內部 `auth_request` 用現有 `X-DuSheng-Line-Token` 驗證自己，並以 `X-Proxy-Peer-IP` 傳送實際 TCP 對端位址 `$realip_remote_addr`。它不採信外部呼叫者提供的 X-Forwarded-For；Bot 只接受來自 loopback、內部令牌正確的查詢。這正是 Nginx 使用主機網路的原因。官方映像的 envsubst 僅替換兩個 `DUSHENG_` 設定，不會展開 Nginx 的來源 IP 等變數，也不會額外啟動預設 80 端口。

接著準備涵蓋 `danmu.dusheng.lol` 的正式憑證。可先在 DuShengCDN 的憑證管理申請並綁定此網域，再將有效的完整憑證鏈和對應私鑰部署到源站。若管理端無法匯出私鑰，使用既有 ACME DNS-01 流程在源站簽發；不需要先開放 80 端口。邊緣憑證和源站憑證都必須涵蓋該網域，可使用不同的有效憑證。

取得憑證後，將命令中的來源路徑換成實際位置，複製實際檔案到 `certs/`，避免符號連結指向容器外：

```bash
sudo install -m 600 -o "$(id -u)" -g "$(id -g)" /實際憑證路徑/fullchain.pem certs/fullchain.pem
sudo install -m 600 -o "$(id -u)" -g "$(id -g)" /實際憑證路徑/privkey.pem certs/privkey.pem
```

憑證與內部鑑權設定已排除 Git 和 Docker 建置內容。雲端安全群組／主機防火牆需允許 CDN 節點連到 TCP 9443；應用層 IP 授權仍以 Bot 的即時清單為準，不需維護第二份 Nginx IP 檔案。

先檢查配置及憑證，通過後才啟動 TLS 入口。`nginx -t` 不啟動監聽服務：

```bash
docker compose -f compose.yaml -f compose.cdn.yaml config --quiet
docker compose -f compose.yaml -f compose.cdn.yaml run --rm --no-deps cdn-origin nginx -t
docker compose -f compose.yaml -f compose.cdn.yaml up -d --wait --wait-timeout 120
docker compose -f compose.yaml -f compose.cdn.yaml ps
```

若 `nginx -t` 失敗，先修正憑證、私鑰或設定再啟動。`config --quiet` 只驗證配置；不要改用會列印環境變數內容的普通 `docker compose config`，也不要分享含內部令牌的容器設定輸出。

在 DuShengCDN 面板為 `danmu.dusheng.lol` 設定：

| 項目／欄位 | 設定 |
| --- | --- |
| 回源 URL（`origin_url`） | `https://<源站公網IP>:9443`；IPv6 使用 `https://[<源站IPv6>]:9443` |
| 回源 Host（`origin_host_header`，相容欄位 `origin_host`） | `danmu.dusheng.lol` |
| TLS SNI（`origin_sni`） | `danmu.dusheng.lol` |
| 驗證源站憑證（`origin_tls_verify`） | `true` |
| 站點快取（`cache_enabled`） | `false`，且不要套用會重新啟用快取的規則 |
| 全域 `OpenRestyProxyReadTimeout` | 至少 75 秒，建議 120 秒 |

CDN 必須保留呼叫者送來的 HTTP `Authorization: Bearer <TOKEN>`、`Content-Type` 和請求體。**不要在 CDN 面板填入 TOKEN 讓它自動注入**，也不要將內部 `line_report_token` 放到 CDN；來源節點通過 IP 授權後，彈幕接口仍要求呼叫者自己的 Bearer TOKEN。不要配置會覆寫 Authorization 的 Basic Auth 或自訂請求頭，也不要把 token 拼到 URL。Nginx 請求體上限為 16 KiB，彈幕回源讀寫超時為 75 秒，鑑權子請求及彈幕接口都不快取。

儲存面板設定後，依序**預覽差異 → 檢查回源、SNI、驗證和快取設定 → 發布並啟用版本 → 確認相關 Agent 套用相同版本**。只儲存設定不代表邊緣節點已使用新配置。不要把回源 URL 填成 `https://danmu.dusheng.lol`，以免 DNS 指回 CDN 形成迴圈。

可在 Bot 已信任的 CDN 節點上直接驗證源站 TLS，將 `<源站IPv4>` 換成真實 IP：

```bash
curl --fail --silent --show-error --resolve 'danmu.dusheng.lol:9443:<源站IPv4>' https://danmu.dusheng.lol:9443/healthz
```

不要加 `-k` 跳過憑證驗證。此命令應回傳 `{"status":"ok"}`；若 403，在 Bot 面板確認實際 CDN 出口 IP（包含 NAT 或 IPv6）是否可信。若 5xx，檢查 Bot 的 API、內部鑑權及彈幕服務狀態。來自未信任 IP 的直接回源應得到 403，偽造 X-Forwarded-For 不應改變結果。

CDN 發布並確認 Agent 版本後，驗證對外行為：

```bash
curl --fail --silent --show-error https://danmu.dusheng.lol/healthz
curl --silent --output /dev/null --write-out '%{http_code}\n' https://danmu.dusheng.lol/
curl --silent --output /dev/null --write-out '%{http_code}\n' --request POST --header 'Content-Type: application/json' --data '{}' https://danmu.dusheng.lol/api/v1/dushengtv/danmaku
```

依序應得到健康回應、404 和 401；最後一條刻意不提供 TOKEN，不會呼叫彈幕源。合法 CDN IP 只取得回源資格，不會繞過彈幕接口的 Bearer 驗證。正式 Bot 仍帶令牌經 `127.0.0.1:9321` 呼叫服務，不經 CDN。

IP 清單更新不需要重啟任何入口容器。若 Bot 的內部令牌或 API 端口變更，重新執行 `configure-cdn-origin.py`；Nginx 範本或這兩項設定變更後，檢查並重建入口容器：

```bash
docker compose -f compose.yaml -f compose.cdn.yaml run --rm --no-deps cdn-origin nginx -t
docker compose -f compose.yaml -f compose.cdn.yaml up -d --force-recreate cdn-origin
```

憑證續期後重新複製檔案，檢查成功後可執行 `docker compose -f compose.yaml -f compose.cdn.yaml exec cdn-origin nginx -s reload`。


DuShengTV 的 Bot 接口按使用者限流，每位使用者每分鐘最多 12 次請求。新的 `/api/v1/dushengtv/danmaku` 適配接口不套用舊接口的共用 IP 限制，另限制同時進行的不同影片請求，避免 Bot 共用 IP 時互相影響。

`RATE_LIMIT_MAX_REQUESTS=30` 只控制舊 `/api/v2/comment` 接口中，每 IP 每分鐘未命中快取的請求數；它不會調整 Bot 的每使用者限流，也不限制搜尋。DuShengTV 遇到 429 時，先檢查使用者是否頻繁切換影片、重複請求，或服務是否同時處理過多影片。

**備份。**

以下命令均在倉庫根目錄執行。為取得一致的檔案快照，備份時短暫停止彈幕服務；Bot 的其他功能仍可繼續使用。

```bash
umask 077
mkdir -p backups
docker compose stop danmu-api
tar -czf "backups/danmu-$(date +%Y%m%d-%H%M%S).tar.gz" config data certs
docker compose start danmu-api
```

備份包含 token、`config/` 內的回源設定、本地彈幕及 `certs/` 內的 TLS 私鑰，請保存到私人位置。如果只部署本機接口且尚未建立 `certs/`，從備份命令移除該參數。即使 `tar` 失敗，也要執行 `docker compose start danmu-api` 恢復服務，並處理備份錯誤。

**更新與回退。**

先完成上述備份，再執行：

```bash
git status --short
git rev-parse HEAD > backups/code-before-update.txt
docker image tag dushengtv/danmu-api:local dushengtv/danmu-api:previous
git pull --ff-only
docker compose build --pull
docker compose up -d --wait --wait-timeout 120
curl --fail --silent --show-error http://127.0.0.1:9321/healthz
docker compose exec -T danmu-api node --input-type=module < scripts/smoke-dushengtv.mjs
```

若 `git status` 顯示自己的程式修改，先保存並處理它們；`git pull --ff-only` 失敗時不要繼續建置。設定和資料由掛載目錄保留，不必重新產生 token。不要改為拉取上游 `logvar/danmu-api` 映像，因為它沒有本分支的 DuShengTV 接口。

若已啟用遠端 CDN TLS 入口，每次更新後也檢查並重建入口容器，確保新的範本和 9443 設定生效：

```bash
docker compose -f compose.yaml -f compose.cdn.yaml run --rm --no-deps cdn-origin nginx -t
docker compose -f compose.yaml -f compose.cdn.yaml up -d --force-recreate cdn-origin
```

需要回到上一個已建置映像時：

```bash
docker image tag dushengtv/danmu-api:previous dushengtv/danmu-api:local
docker compose up -d --no-build --pull never --wait --wait-timeout 120
```

這只回退容器程式，不回退 Git 原始碼或資料；下次重新建置會再次使用目前分支。若未來版本更改資料格式，請先閱讀更新說明，再決定是否還原備份。

已在本地使用隔離設定與快取啟動真實 Node HTTP 服務，通過健康檢查、Bearer 鑑權、16 KiB 請求限制、S00／E00 提示，以及本地彈幕上傳、讀取、格式檢查和刪除；沒有存取外部彈幕源。需要重跑時，在已安裝 Node.js 的開發環境執行：

```bash
npm ci
node scripts/test-dushengtv-http.mjs
```

此驗收使用隨機令牌與臨時目錄，強制測試服務僅監聽本機並阻止外部連線，結束後關閉程序及清理臨時資料。它不讀取或修改正式的 `config/.env`、`data/`。

另外已用官方 Nginx 1.28.0 執行隔離 TLS 驗收，15 項檢查通過，包含 Bot 節點即時允許／撤銷、偽造來源標頭拒絕、方法與大小限制、管理路徑封閉，以及 Bot 無法連線時拒絕回源。可用 `python scripts/test-cdn-origin.py --help` 查看重跑方式；此測試使用模擬 Bot／彈幕後端，不讀取正式設定或令牌。

本地開發環境未安裝 Docker，因此 Docker 建置、容器健康檢查和上游來源連通性需在伺服器依部署步驟確認；Node HTTP 與 Nginx TLS 驗收不是 Docker 實測。
