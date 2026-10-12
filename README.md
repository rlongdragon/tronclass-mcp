# tronclass-mcp

海大 TronClass（`https://tronclass.ntou.edu.tw`）的 MCP server。

這個專案只負責把 [tronclass-api](https://github.com/rlongdragon/tronclass-api) 包成 MCP tool，登入、session 與 API 呼叫都由 tronclass-api 處理。要新增功能時，先在 tronclass-api 加方法，再到這裡加對應的 tool。

## Tools

| Tool | 說明 |
|---|---|
| `login` | 開始登入，回傳 4 位數字驗證碼圖片 |
| `submit_captcha(code)` | 送出驗證碼完成登入 |
| `whoami` | 目前使用者（id、姓名、學號、系所） |
| `list_todos` | 待辦事項 |
| `list_courses(status?)` | 我的課程（含課程 ID）；`status` 為 `ongoing`（預設）、`notStarted`、`closed` 或 `all` |
| `list_semesters` | 我的學期 |
| `list_recent_courses` | 最近瀏覽的課程 |
| `get_course_modules(course_id)` | 某門課的週次／章節 |
| `list_announcements(course_id?, keyword?, start_date?, end_date?, page?)` | 課程公告（不指定課程時為所有課程），內容轉成純文字 |
| `list_school_announcements(page?)` | 全校公告 |
| `list_notifications(limit?, types?)` | 通知與未讀數量 |
| `list_homework(course_id)` | 某門課的作業 |
| `get_homework(activity_id)` | 作業詳情與我的歷次繳交、草稿、分數、評語 |
| `list_exams(course_id)` | 某門課的線上考試 |
| `get_scores(course_id)` | 某門課的考試成績與作業分數 |
| `list_forum_topics(course_id)` | 某門課各討論區的主題 |
| `get_topic(topic_id)` | 討論區主題內容與回覆 |
| `list_materials(course_id)` | 某門課的學習活動（教材、作業、影片等）與附件 |
| `download_material(reference_id)` | 下載附件到本機，回傳檔案路徑 |
| `save_homework_draft(activity_id, file_paths, comment?, multiple_choice_title?)` | **寫入**：上傳本機檔案並存成作業草稿（覆蓋現有草稿，不會繳交） |
| `submit_homework(activity_id, multiple_choice_title?)` | **寫入**：把草稿正式繳交 |
| `retract_submission(submission_id)` | **寫入**：撤回已繳交的作業（作業需允許撤回），撤回後變回草稿 |

時間欄位都是 UTC。

標示**寫入**的 tool 會改動 TronClass 資料，MCP annotation 標為 destructive。正式繳交與撤回前應先向使用者確認；建議流程是 `save_homework_draft` → 用 `get_homework` 確認草稿 → 使用者同意後 `submit_homework`。寫入途中需要重新登入時，該操作不會執行，登入後也不會自動重做。不支援分組作業；只能上傳一般檔案（不能是隱藏檔、隱藏目錄或 `/etc` 等系統目錄中的檔案），單檔上限 100 MB。

lib 每分鐘最多送 60 個請求，需要排隊超過 20 秒時 tool 會直接回報「請求太頻繁」。

## 登入流程

CAS 登入頁需要 4 位數字的圖片驗證碼，這裡交給 MCP client 端的模型辨識：

1. 任何 tool 在還沒登入、或 session 過期需要重新登入時，會回傳驗證碼圖片。
2. 模型辨識後呼叫 `submit_captcha`。
3. 登入成功後，重新呼叫剛才的 tool。

驗證碼錯誤時會自動回傳新的驗證碼，連續錯 5 次會停下來，稍後再呼叫 `login`。帳號或密碼錯誤時不會自動重試（避免帳號被鎖），其他 tool 也不會再自動登入，確認帳密後再呼叫 `login`。

注意：部分模型可能會拒絕辨識驗證碼。

## 安裝

```bash
npm install
npm run build
```

目前透過 `file:../tronclass-api` 引入 tronclass-api，兩個專案需放在同一層目錄，且 tronclass-api 需先 `npm install`（會自動 build）。

## 設定

帳密由環境變數提供：

| 變數 | 說明 |
|---|---|
| `TRON_USER` | 學號 |
| `TRON_PASS` | 密碼 |
| `TRON_BASE_URL` | 選填，預設 `https://tronclass.ntou.edu.tw` |
| `TRON_DOWNLOAD_DIR` | 選填，附件下載目錄，預設 `~/Downloads/tronclass` |

### Claude Code

在專案的 `.mcp.json` 引用 shell 的環境變數，避免把密碼寫進設定檔：

```json
{
  "mcpServers": {
    "tronclass": {
      "command": "node",
      "args": ["/absolute/path/to/tronclassMCP/dist/index.js"],
      "env": {
        "TRON_USER": "${TRON_USER}",
        "TRON_PASS": "${TRON_PASS}"
      }
    }
  }
}
```

### Claude Desktop

在 `claude_desktop_config.json` 的 `mcpServers` 加入同樣的設定，`env` 填入實際的帳密。

## 文件

- [docs/api-reference.md](docs/api-reference.md)：TronClass API 研究整理（endpoint、繳交作業流程、tool 規劃）。
