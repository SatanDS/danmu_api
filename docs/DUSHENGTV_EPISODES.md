# DuShengTV 分季分集匹配

DuShengTV 的受认证弹幕接口现有电影 ID 匹配不变。电视剧走独立的严格匹配：准确剧名（允许源站的同义名）、准确季数和源站明确标注的集数同时符合才返回弹幕。

不再借用通用客户端匹配器的跨季顺延、不限季兜底、数组位置或 AI 猜测。源站的 `episodeNumber` 由数组生成，不能证明实际集号；例如源站只剩第 5–8 集，客户端请求第 4 集时不能取数组第四项第 8 集。预告、花絮、特辑等也不作为正片匹配。

未标季号仅可作为第 1 季；不同季别名冲突、同名同季但多个年份的版本、缺少明确集数均返回“無彈幕匹配”。特别季和第 0 集延续明确提示，不会默认为第一集。通用弹弹play等接口原有人工映射不受影响。

本地上传同样核对季数和集数。新的电视剧 SQLite 缓存 key 版本隔离旧匹配结果，避免升级后继续复用已缓存的跨季错误；电影缓存保留。

更新服务：

```bash
cd /opt/danmu
git pull --ff-only
docker compose up -d --build danmu-api
curl --fail http://127.0.0.1:9321/healthz
```

保留现有 `.env`、TOKEN 和 `.cache` 持久化目录。无需修改 Bot 的弹幕地址或密钥。

验证：

```bash
node --test danmu_api/utils/dushengtv-episode-match.test.js danmu_api/dushengtv-matching.test.js danmu_api/apis/clients/dushengtv-api.test.js danmu_api/utils/dushengtv-cache.test.js
```

测试在隔离缓存目录注入源站数据并经过实际 HTTP 路由，确认准确第二季第四集可取弹幕，错误季、缺集、预告和数组位置不能冒充该集。不能匹配的来源需完善源站集号或人工导入准确弹幕，不按宽松规则自动换成其他内容。
