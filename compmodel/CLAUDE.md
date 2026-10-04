# 原岩攀岩比賽系統（origin-climb）

## 給 Claude Code 的背景
- 開發者：Yam，原岩攀岩館老闆，程式初學者。**所有說明與介面文字一律使用繁體中文**，解釋要白話、一步一步。
- 這個專案從 claude.ai 對話中做出的單檔 HTML 原型轉過來，原型在 `reference/firebase-version.html`，功能已用 Playwright 測試通過（`reference/e2e-test-firebase.py` + `reference/mock-firebase.js`）。
- **目標技術架構：GitHub（程式碼）＋ Supabase（資料庫／登入／即時同步／照片儲存）＋ Netlify（網站上線，連 GitHub 自動部署）。** 原型用的是 Firebase，要改成 Supabase。
- 未來原岩的其他系統（會員系統、路線 app、教練訓練系統）也會用同一套架構，資料結構請保留未來整合的彈性。

## 系統功能（必須全部保留）
1. **入口頁**：列出所有比賽（新到舊），進行中的比賽標「進行中」，自己主辦的標「我主辦」。
2. **任何人都可以建立比賽**，不需要註冊（Supabase 匿名登入）。建立時設定：比賽名稱、組別（預設男子組 5 條、女子組 5 條，可增減組別與路線數）、每輪攀爬分鐘、每輪休息分鐘。
3. **身分**
   - 主辦：建立者。控制計時、開關「選手自行記分」、上傳路線照片並圈路線、幫任何選手記分／修正、刪除選手、清除成績、刪除比賽。
   - 協同主辦：輸入 6 碼「管理碼」的人，權限同主辦（給裁判、或主辦換手機時取回權限）。
   - 選手：任何點連結進來的人。填名字＋選組別報名，只能記自己的成績。
   - 系統管理員：Yam 用 Email 登入，可管理所有比賽、匯入／匯出 JSON 備份。
4. **計分**（每條路線）：Top 25 分、Zone 10 分，只取最高項不相加。第一次達成不扣分，第二次起每多一次嘗試扣 0.1 分。
   - Top 分 = 25 − 0.1 ×（完攀那次的次數 − 1）
   - 否則 Zone 分 = 10 − 0.1 ×（第一次到 Zone 的次數 − 1）
   - 每次嘗試記為 `f`（失敗）、`z`（到 Zone）、`t`（完攀，含 Zone）。完攀後該路線鎖定。
5. **排行**：每個組別有「總排行」（各路線加總，同分比 Top 數、再比 Zone 數）與各路線排行。所有手機即時同步。
6. **計時器**：全場共用、所有手機同步。資料只存 `{round, running, elapsed, startedAt}`，各裝置自行計算目前輪次與剩餘時間：
   - 休息 > 0：cycle = 攀爬 + 休息，round = 基準 round + floor(E / cycle)，自動輪替
   - 休息 = 0：每輪結束停在「時間到」，按「下一輪」才繼續
   - E = running ? elapsed + (now − startedAt) : elapsed
   - 最後 60 秒變黃並嗶兩聲、最後 5 秒每秒嗶、結束長嗶＋震動；計時中保持螢幕不關（Wake Lock）。每台手機可自己關提示音。
7. **路線照片＋圈路線**：主辦上傳照片（前端壓縮到長邊 1000px JPEG），再用編輯器在照片上點擊加圈、拖曳移動、調大小、刪除、復原。圈的種類：手點（綠）、腳點（綠虛線）、Start（藍 S）、Zone（黃 Z）、Top（紅 T）。座標存 0~1 比例 `{x, y, r, type}`，所有人看得到，點照片可全螢幕放大。
8. **手機優先**設計，計時器固定在畫面頂端，支援深色模式。

## 權限規則（必須在資料庫層強制，不能只靠前端）
- 所有人可讀比賽、成績、照片、報名。
- 只有主辦／協同主辦／系統管理員能改比賽設定、計時、照片、裁判成績、刪除。
- 選手只能新增／修改／刪除自己的報名；主辦關閉自行記分時，選手不能改成績。
- 管理碼只有主辦看得到；驗證在伺服器端進行。
- 不能把比賽的主辦轉給別人。
- 參考：`reference/firestore.rules`（Firebase 版）與 `supabase/schema.sql`（Supabase 草稿，**尚未實際測試**，請先檢查與測試）。

## 舊資料搬移
- `data/firebase-export.json`：目前「原岩模擬賽」完整資料（含 10 張圈好的路線照片、6 位選手、成績）。格式 `{app, version, docs: {path: data}}`，path 例如 `comps/<id>`、`comps/<id>/climbers/<id>`、`comps/<id>/results/<climberId>__<routeId>`、`comps/<id>/photos/<routeId>`（照片為 data URL）。
- 需要寫一個匯入腳本把它轉進 Supabase（照片改存 Storage）。
- `data/` 含選手姓名與照片，已在 .gitignore 排除，**不要提交到 GitHub**。

## 建議的開發順序
1. 建立 Supabase 專案、執行並測試 schema.sql、啟用匿名登入
2. 把原型的資料層從 Firebase 換成 supabase-js（含 Realtime 訂閱）
3. 照片改用 Supabase Storage
4. 寫匯入腳本搬舊資料
5. 設定 Netlify 連 GitHub 自動部署，環境變數放 Supabase URL 與 anon key
6. 用兩支手機實測：主辦計時、選手報名記分、管理碼取回權限
