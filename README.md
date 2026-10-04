# 原岩攀岩比賽系統

攀岩比賽報名、自行記分、即時排行與計時系統。

- 技術：GitHub + Supabase + Netlify
- **上線步驟（一步一步）**：見 [`docs/上線步驟.md`](docs/上線步驟.md)
- 開發說明：見 `CLAUDE.md`

## 資料夾
| 位置 | 內容 |
|---|---|
| `web/` | 網站本體（Netlify 發布這裡） |
| `supabase/schema.sql` | 資料庫結構與權限，貼到 Supabase SQL Editor 執行 |
| `supabase/tests/` | 資料庫權限測試 |
| `tests/` | 端對端測試（Playwright） |
| `reference/` | 舊的 Firebase 原型，僅供參考 |
