# 相對主線的功能更新整理

整理日期：2026-10-27

## 比較範圍

- 工作目錄：`/mnt/D/boan/sst-cvat`，目前分支為 `feature/video-annotation`。
- 此 repository 沒有名為 `main` 的本地或遠端分支；本文件以預設主線 `sst-main` 為基準。
- 本地 `sst-main`、`origin/sst-main` 與目前 `HEAD` 都指向 `bcddd4037936581ceff840d45970a12d78917045`。本次沒有 fetch，遠端基準是本地已取得的版本。
- 功能差異來自**尚未提交的修改及未追蹤的新檔案**，不是已提交的分支 commit。整理前共有 22 個已追蹤檔案修改及 46 個未追蹤檔案；不含本文件。
- 以實際程式碼、migration 與測試內容為依據。以下「新增／修復」描述工作目錄中的實作，不代表所有功能都已部署或通過正式驗收。

## 功能總覽

| 類別 | 相對主線的增加或變更 | 使用者可見效果 |
| --- | --- | --- |
| 原始影片標註 | 新增 Original MP4 工作流程 | 上傳原始 MP4，直接進入原生 CVAT Job 標註 |
| 影片時間軸 | 依影片 presentation timestamps 對應 frame | 以秒定位，支援原始 MP4 的可變幀率時間對應 |
| SAM2 影片追蹤 | 新增背景推論、進度、取消、結果接受 | 從已儲存的 mask／polygon 向後追蹤多個物件 |
| 遮罩審查 | 新增獨立圖層、結果管理、局部後處理 | 檢視、刪除或修正指定物件與影格的遮罩 |
| 播放效能 | 新增按需影片分段、預載及瀏覽器快取 | 降低遠端連線重複下載，改善審查播放連續性 |
| 資料保護 | 新增版本衝突檢查與推論來源追蹤 | 避免過期結果覆蓋人工修改或誤刪其他標註 |
| 部署 | UI、API 與 workers 從目前 checkout 建置 | 減少修改原始碼但仍執行舊映像的情況 |
| 相容性修復 | 舊資料庫欄位修復、健康檢查警告處理 | 修復任務建立失敗及磁碟警告導致 UI 無法使用 |

## 新增功能

### 1. 原始 MP4 標註流程

- Create task 增加 **Standard frame annotation** 與 **Original MP4 annotation** 選項。
- Original 模式需選擇 Project 與單一本機 H.264 MP4；透過 **Upload & Open Original Video** 建立原生 Task／Job 並開啟標準工作區。
- 沿用 CVAT 原有標籤、屬性、繪圖、mask 編修、undo／redo 及資料集匯入匯出能力，工具是否可用依標籤與物件類型決定。
- 原始 MP4 保持不變；上傳時建立時間戳索引，不預先輸出完整逐幀圖片。Task raw-data 以 hard link 連結同一份影片；伺服器按需要解碼影格供推論或匯出。
- 前端由瀏覽器解碼原始影片供標註畫布使用；時間滑桿與輸入欄改以秒顯示，內部標註仍使用精確影格索引。
- 舊 `/projects/<id>/videos/<uuid>` 入口可開啟對應的原生 Job；早期時間區間式 rectangle／polygon 標註在初始化工作區時轉為原生 tracks。
- 任務卡片對 interpolation 類型加上「影片」標籤，並調整任務列表空狀態及捲動方式。

主要檔案：[original-video.ts](cvat-core/src/original-video.ts)、[native_workspace.py](cvat/apps/video_annotation/native_workspace.py)、[original_views.py](cvat/apps/video_annotation/original_views.py)、[create-task-content.tsx](cvat-ui/src/components/create-task-page/create-task-content.tsx)、[player-navigation.tsx](cvat-ui/src/components/annotation-page/top-bar/player-navigation.tsx)。

### 2. SAM2 影片物件追蹤

- 2D 標註工作區新增 **SAM2 Video** 按鈕；mask 物件選單新增 **SAM2: Track subsequent frames**。
- 使用目前影格已儲存的獨立 mask／polygon 作為起始提示，指定結束影格後向後追蹤。
- 推論由 annotation queue 執行，關閉面板不會中止工作；可重新查看近期 runs、進度、錯誤與取消狀態。
- 結果先審查，再透過 **Accept masks** 寫入可編修的 CVAT shapes，保留起始提示。
- 新增內部 SAM2 服務及模型快取 volume；預設模型為 `facebook/sam2.1-hiera-tiny`。
- `SAM2_DEVICE=auto` 在 CUDA 可用且剩餘顯存至少 3 GiB 時選用 CUDA，否則選 CPU；可指定 `cuda`／`cpu`，CPU threads 預設 8。

主要檔案：[sam2-video.tsx](cvat-ui/src/components/annotation-page/top-bar/sam2-video.tsx)、[worker.py](cvat/apps/video_annotation/worker.py)、[views.py](cvat/apps/video_annotation/views.py)、[server.py](components/sam2/server.py)。

### 3. 遮罩審查、管理與後處理

- 原始影像與 mask 使用獨立圖層，支援逐物件顯示／隱藏、Solo 與透明度調整。
- **Manage SAM2 masks** 按 run／label 管理結果；支援刪除指定 run／label 的生成結果，以及目前影格的個別遮罩。
- 新推論保存每個影格的 float32 logits，供前端即時調整 threshold（-10～10）及邊緣平滑半徑（0～10 原始像素），不必重跑模型。
- 預覽與儲存分開：接受推論先匯入原始二值預測；之後明確套用預覽，只修改選定物件與目前影格。
- 平滑單獨使用時以目前儲存的遮罩為起點；threshold 使用原始推論分數，明確套用時可能取代該遮罩的人工修正。空遮罩不可套用。
- 舊 runs 若沒有 logits，仍可平滑，但需重新推論才有 threshold 功能。

主要檔案：[sam2-mask-review.tsx](cvat-ui/src/components/annotation-page/top-bar/sam2-mask-review.tsx)、[sam2-results-manager.tsx](cvat-ui/src/components/annotation-page/top-bar/sam2-results-manager.tsx)、[sam2-mask-processing.ts](cvat-ui/src/utils/sam2-mask-processing.ts)。

### 4. 推論快照匯出

- 新增 **Download inference ZIP**，保存單次推論的模型、範圍、物件、提示、標註指紋與結果。
- ZIP 包含 `manifest.json`、`objects.json`、`prompts.json`、`annotations.jsonl`、`cvat_masks.json`；有舊預覽影片時可包含 `preview.mp4`，新 runs 不再產生合成預覽 MP4。
- 同時提供 COCO RLE 與 CVAT RLE，兩者排列／裁切方式不同，不能直接互換。
- 推論 ZIP 是單次推論快照；若要匯出後續人工修正，仍使用原生 **Export job dataset**。

## 播放與效能改善

| 改善 | 實作與效果 |
| --- | --- |
| 開啟 Job | 平行取得 metadata、frame numbers、annotations 與 issues；Original MP4 不再預先解碼不會使用的首張 bitmap |
| 影片與遮罩分離 | Original MP4 審查以影片時間驅動 overlay，不用逐幀 seek 推動畫面 |
| 遮罩播放快照 | 每次播放取得精簡的已儲存 mask 快照；播放不逐幀下載 logits，已接受的結果可反映後續修改 |
| 按需影片分段 | 產生約 5 秒、360p／400 kbps 的 fragmented MP4；先載入目標與下一段，以 MediaSource 接續播放 |
| 伺服器快取 | 僅編碼請求的片段，以檔案鎖及原子寫入避免重複產生或讀到不完整檔案 |
| 瀏覽器快取 | IndexedDB 依影片 UUID 與編碼 profile 保存片段，容量上限 256 MiB、7 天過期、LRU 淘汰 |
| 跳轉與降級 | seek 取消上一輪下載並優先目標片段；IndexedDB 不可用時回到網路載入 |
| 精確編修 | 暫停編修仍使用原始解析度影格；360p proxy 僅供播放 |

主要檔案：[sam2-video-playback.tsx](cvat-ui/src/components/annotation-page/top-bar/sam2-video-playback.tsx)、[sam2-video-segments.ts](cvat-ui/src/utils/sam2-video-segments.ts)、[sam2-frame-buffer.ts](cvat-ui/src/utils/sam2-frame-buffer.ts)、[sam2-video-timing.ts](cvat-ui/src/utils/sam2-video-timing.ts)、[video_segments.py](cvat/apps/video_annotation/video_segments.py)、[playback.py](cvat/apps/video_annotation/playback.py)。

## 修復與資料保護

### 1. 磁碟警告造成「Cannot connect to the server」

- 主線只設定 `DISK_USAGE_MAX`，健康檢查套件預設會把警告視為錯誤，磁碟使用率超過 90% 時可能回傳 HTTP 500，前端因此阻擋使用。
- 新增 `CVAT_HEALTH_WARNINGS_AS_ERRORS`，預設 `false`：容量警告仍顯示，單純警告不再導致 UI 無法使用；資料庫、快取或 OPA 的真正故障仍會回傳 500。
- `CVAT_HEALTH_DISK_USAGE_MAX` 預設仍是 90%，這次修復不是把門檻提高到 95%。需要嚴格監控時可將 warnings-as-errors 設回 `true`。
- 設定影響健康檢查的 warning 類別，不只磁碟警告。

主要檔案：[base.py](cvat/settings/base.py)、[docker-compose.yml](docker-compose.yml)、[health/tests.py](cvat/apps/health/tests.py)。

### 2. 重用資料庫時建立 Task 遇到 NOT NULL 錯誤

- 新增 `repair_legacy_task_schema` 管理指令。
- 僅當目前 Task model 不管理 `media_type`，但資料庫仍有該欄位的 NOT NULL 約束時，移除此約束，保留欄位與既有值。
- Server 在 migrations 後執行；Compose 預設 `CVAT_REPAIR_LEGACY_TASK_SCHEMA=yes`，可設 `no` 停用。可重複執行，正常新資料庫不需變動。
- 這是特定欄位的相容性修復，不是一般資料庫版本降級機制。

主要檔案：[repair_legacy_task_schema.py](cvat/apps/engine/management/commands/repair_legacy_task_schema.py)、[backend_entrypoint.sh](backend_entrypoint.sh)。

### 3. 避免推論結果覆蓋人工標註

- 推論記錄起始標註指紋；標註版本已變更時拒絕接受過期結果。
- 接受結果可重複呼叫而不重複新增；再次追蹤同一物件時維持物件身分。
- 重疊區間僅替換未被人工修改的舊預測；遇到人工修正則回報衝突。
- 刪除依 run 的來源紀錄辨識結果，保護 seed 與無關標註，不直接刪除所有 `source=auto` 物件。
- 新增 API 沿用 Project／Job／organization 權限，讀取影片需 data 權限，修改需 annotation write 權限，匯出需 export 權限。

## 部署與資料結構變更

- 新增 Django app `cvat.apps.video_annotation` 與三個 migrations，建立推論 runs、原始影片紀錄，以及影片對 Task 的關聯與時間戳欄位。
- 新增 `original-videos` 專案 API、Job 的 `original-video`／`segments` API，以及 `video-inference` 的建立、取消、接受、結果管理、mask 編修、播放快照與匯出 API。
- UI 增加直接宣告的 `axios` 相依套件（`^1.12.0`），並更新 lockfile。
- Compose 增加共用 backend build 設定，API 與所有 workers 使用同一套來源建置；UI 也從目前 checkout 建置，`pull_policy: build` 讓 `up` 使用建置快取更新映像。
- SAM2 由 `sam2` profile 啟用，服務不對主機公開 port，模型保存在 `sam2_models` volume。
- 更新既有部署必須保留原本 Compose project name 與 override files，才能沿用資料 volumes 及 serverless 整合。

## 現有限制與待驗收項目

- SAM2 目前為向後續影格追蹤；每次 1～10 個獨立 mask／polygon prompts、預設 2～300 frames，尚不支援 track-mode prompts、反向追蹤或自動 point／box prompts。
- 每個 Job 同時只能有一個 active run，推論服務一次只執行一個工作；取消在下一個處理節點生效，不會立即中斷 GPU kernel 或模型下載。
- 影格面積上限為 4K，影格 archive 限制為 512 MiB；logits 會額外占用磁碟與傳輸空間。
- 程式支援 CPU fallback，但目前 Compose 仍宣告 NVIDIA GPU reservation；純 CPU 主機還需調整部署設定，不能只設定 `SAM2_DEVICE=cpu` 就假設可啟動。
- 分段快取減少重複傳輸；持續頻寬低於 proxy bitrate 時仍需緩衝。Original MP4 overlay 最多約每秒更新 10 次，標準逐幀任務審查保留 5 fps 路徑。
- 原始影片工作區使用原生 timestamps；標準逐幀任務與推論快照不能一概視為完整重建來源 VFR 時間資訊。
- threshold／平滑設定是 inspector 內的局部預覽，不是已保存的全影片批次處理配方；尚無完整專案版本化匯出。

## 測試與驗證狀態

程式碼已新增以下回歸測試；後續部署時已執行的結果記錄於文件末尾，其餘測試不因存在測試檔案就視為已通過驗收。

| 測試範圍 | 檔案／目錄 |
| --- | --- |
| 推論編碼、權限、範圍、取消、接受、衝突、人工修改保護、匯出 | `cvat/apps/video_annotation/tests.py` |
| 原始影片上傳、版本衝突、隔離、Range、刪除、原生工作區 | `cvat/apps/video_annotation/test_original.py` |
| 播放快照與影片分段／編碼快取 | `test_playback_snapshot.py`、`test_video_segments.py` |
| 磁碟警告不阻擋、資料庫故障、嚴格監控 | `cvat/apps/health/tests.py` |
| 遮罩後處理、frame buffer、VFR 時間對應 | `tests/node/sam2-*.cjs` |
| 真實影片低頻寬播放、跨段、預載後斷線、重載快取、跳轉 | `tests/browser/sam2-native-playback.cjs`；API 使用 fixtures，不等同實際部署的登入整合測試 |

可依環境執行：

```bash
python manage.py test cvat.apps.video_annotation cvat.apps.health --settings=cvat.settings.testing
python3 -m unittest cvat.apps.video_annotation.test_playback_snapshot -v
node --test tests/node/sam2-*.cjs
```

完整 GPU、編碼與瀏覽器測試的依賴／指令見 [SAM2 README](components/sam2/README.md)。

### 本次已確認的部署修復

2026-10-27 排查發現，執行中的 `cvat_server` 來自 `/home/LianChia/sst-cvat` 的舊設定，並非本工作目錄的更新版本。已在執行容器、該部署來源及本機 `cvat/server:dev` 映像套用容量警告修復並重啟後端。健康檢查在磁碟使用率仍為 91.8% 時已回傳 **HTTP 200**，資料庫、快取及 OPA 均為 working。

這項最初的現場修復僅涵蓋健康檢查；後續完整部署如下。

### 完整 feature 部署與驗證（2026-10-27）

- 已從 `/mnt/D/boan/sst-cvat` 建置並更新 API、UI、所有 workers 與 SAM2，沿用 `sst_cvat` project、原有資料 volumes 及 serverless override。
- 發現共用 `cvat/ui:dev` 標籤與本次建置結果不一致，導致更新後仍載入缺少影片選項的前端；改用專屬 `cvat/ui:feature-video-20261027` 與 `cvat/server:feature-video-20261027`，並核對實際送出的 bundle。
- 本地 `.env` 已固定 `CVAT_VERSION`、`CVAT_HOST=localhost`、project name、三份 Compose files 與 `sam2` profile；此檔為本機部署設定，未納入版本控制。
- 遠端服務繼續使用 port 8080，SSH 轉接仍可用 `http://localhost:8080/`。更新後若分頁仍載入舊 JavaScript，需重新載入頁面。
- 三個 `video_annotation` migrations 均已套用；健康檢查 HTTP 200，資料庫、快取與 OPA 正常，磁碟容量警告保留。
- 在實際部署的 `/tasks/create?projectId=7` 以瀏覽器驗證：**Original MP4 annotation** 選項可見，選取後出現 **Upload & Open Original Video** 按鈕，無 JavaScript 執行錯誤；驗證用臨時 session 已撤銷，未上傳或修改正式任務。
- 專屬後端映像在獨立容器及測試資料庫執行 44 項測試，結果 `OK (skipped=1)`；未連入正式資料庫。另有 9 項 Node 測試、3 項播放快照及 3 項本機影片分段測試通過。
- 瀏覽器 512 kbps 播放回歸通過：跨段播放、預載後斷線播放、重載快取命中，以及未快取跳轉僅下載目標片段。
- SAM2 服務以 CUDA 在 RTX 3090 完成兩個合成影格的真實推論。這是服務層 smoke test，不代表已執行整套真實 GPU 工作流程測試。
- 更新前資料庫備份與部署設定保存在 `/root/cvat-deployment-backups/20261027/`；建置、部署與測試紀錄位於 `/mnt/D/boan/cvat-deployment-backups/20261027/`。

### SAM2 結束影格預覽與曲線平滑（2026-10-29）

- End frame 改為逐影格滑桿，Original MP4 使用實際時間戳顯示秒數；面板內同步預覽結束影格，保留起始影格與提示物件。快速拖動會忽略過期預覽。
- 新增 Edge smoothing (curve fit)（0–5），追蹤遮罩輪廓並進行曲線平滑，不需要 logits。支援比較、重設及接受結果後套用到指定物件／影格；未按套用前不修改已存標註。
- Job 4 的 `b1458b9d` 結果沒有 logits 檔案，因此 threshold 停用符合資料現況；曲線平滑可直接使用現有遮罩。
- 36 項 Node 測試、變更檔案 ESLint、結束影格瀏覽器測試及播放圖層瀏覽器回歸通過。全專案 TypeScript 檢查仍有既存錯誤，本次修改的 SAM2 檔案未出現錯誤。
- 已建置並更新 `cvat_ui`，健康檢查 HTTP 200。此更新未修改後端資料結構或正式標註。
- 實際部署的 Job 4／`b1458b9d` 已以瀏覽器確認：End frame 秒數與畫面預覽正常、無 logits 時曲線平滑仍可操作、threshold 正確停用，沒有 JavaScript 執行錯誤；未套用遮罩或更動標註。驗證用臨時登入 session 已撤銷。
