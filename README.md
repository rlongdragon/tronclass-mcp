# tronclass-mcp

國立臺灣海洋大學 TronClass（`https://tronclass.ntou.edu.tw`）的非官方 MCP server。接上 Claude Code、Claude Desktop 等 MCP client 後，可以直接用對話查課程公告、作業、待辦、教材、成績、分組，下載教材，以及存草稿和繳交作業。

> 本專案不是海大或 TronClass（WisdomGarden）官方的工具，也未受其委託或背書。TronClass 或 CAS 登入頁改版時，部分功能可能暫時失效。

## 可以做什麼

- 「軟體工程最新的公告是什麼？」
- 「我這週有哪些作業還沒交？」
- 「期末專案我在第幾組？組員有誰？」
- 「把資料庫系統第三章的投影片下載下來。」
- 「把這份 PDF 存成作業一的草稿。」確認無誤後再說「正式繳交」。

## 架構

```
MCP client（Claude Code / Claude Desktop）
        │  stdio
        ▼
tronclass-mcp      ← 本專案：把 API 包成 MCP tool、驗證碼交給模型辨識、整理輸出
        │  import
        ▼
tronclass-api      ← 登入、session、各個 TronClass API（https://github.com/rlongdragon/tronclass-api）
        │  HTTPS
        ▼
tronclass.ntou.edu.tw / tccas.ntou.edu.tw
```

TronClass 的登入、session 管理與 API 呼叫都在 [tronclass-api](https://github.com/rlongdragon/tronclass-api)，本專案只是外殼。要新增功能時，先在 tronclass-api 加方法，再到這裡加對應的 tool。

## 快速開始

需要 Node.js 20.6 以上（用到 `--env-file`）與 git。

### 1. 安裝與建置

```bash
git clone https://github.com/rlongdragon/tronclass-mcp.git
cd tronclass-mcp
npm install
npm run build
```

tronclass-api 會從 GitHub 安裝，安裝時透過它的 `prepare` script 自動 build。若 npm 顯示 `allow-scripts` 警告，而且 `node_modules/tronclass-api/dist` 不存在，請執行 `npm approve-scripts tronclass-api` 後重新 `npm install`。

### 2. 設定帳密

帳密放在本機的設定檔，只有自己讀得到，不會寫進 MCP client 的設定，也不會進 git：

```bash
mkdir -p ~/.config/tronclass-mcp
install -m 600 /dev/null ~/.config/tronclass-mcp/.env
nano ~/.config/tronclass-mcp/.env
```

```
TRON_USER=你的學號
TRON_PASS=你的密碼
```

帳號就是海大教務系統（AIS）的帳號。

### 3. 接上 MCP client

**Claude Code**（加到使用者層級，所有專案都能用）：

```bash
claude mcp add -s user tronclass -- node --env-file=$HOME/.config/tronclass-mcp/.env /絕對路徑/tronclass-mcp/dist/index.js
```

**Claude Desktop**：在 `claude_desktop_config.json` 的 `mcpServers` 加入：

```json
{
  "mcpServers": {
    "tronclass": {
      "command": "node",
      "args": [
        "--env-file=/home/你/.config/tronclass-mcp/.env",
        "/絕對路徑/tronclass-mcp/dist/index.js"
      ]
    }
  }
}
```

設定後重開 client，在 Claude Code 可用 `/mcp` 確認 `tronclass` 已連線。

### 環境變數

| 變數 | 說明 |
|---|---|
| `TRON_USER` | 學號（必填） |
| `TRON_PASS` | 密碼（必填） |
| `TRON_BASE_URL` | 選填，預設 `https://tronclass.ntou.edu.tw` |
| `TRON_DOWNLOAD_DIR` | 選填，教材下載目錄，預設 `~/Downloads/tronclass` |

## 登入流程

海大 CAS 登入頁需要 4 位數字的圖片驗證碼，本專案把驗證碼交給 MCP client 端的模型辨識：

1. 任何 tool 在還沒登入、或 session 過期需要重新登入時，會回傳驗證碼圖片。
2. 模型看圖後呼叫 `submit_captcha`。
3. 登入成功後，回應會列出剛才因為需要登入而沒有完成的 tool，模型再重新呼叫一次。

- 驗證碼錯誤時會自動換一張新的，連續錯 5 次會停下來，稍後再呼叫 `login`。
- 帳號或密碼錯誤時**不會**自動重試，以免帳號被鎖；其他 tool 也不會再自動登入，確認帳密後再呼叫 `login`。
- 驗證碼放超過 5 分鐘會自動換新。

部分模型可能會拒絕辨識驗證碼。

## Tools

時間欄位都是 UTC。

**登入與個人**

| Tool | 說明 |
|---|---|
| `login` | 開始登入，回傳驗證碼圖片 |
| `submit_captcha(code)` | 送出驗證碼完成登入 |
| `whoami` | 目前使用者（id、姓名、學號、系所） |
| `list_semesters` | 我的學期 |
| `list_notifications(limit?, types?)` | 通知與未讀數量 |

**課程**

| Tool | 說明 |
|---|---|
| `list_courses(status?)` | 我的課程（含課程 ID）；`status` 為 `ongoing`（預設）、`notStarted`、`closed` 或 `all` |
| `list_recent_courses` | 最近瀏覽的課程 |
| `get_course_modules(course_id)` | 週次／章節 |
| `get_my_groups(course_id)` | 課程的分組，以及我所在的組別與組員 |
| `list_announcements(course_id?, keyword?, start_date?, end_date?, page?)` | 課程公告（不指定課程時為所有課程），內容轉成純文字 |
| `list_school_announcements(page?)` | 全校公告 |

**作業、教材、考試**

| Tool | 說明 |
|---|---|
| `list_todos` | 待辦事項（未完成的作業、測驗等） |
| `list_homework(course_id)` | 課程的作業、截止時間、是否已繳交、分數 |
| `get_homework(activity_id)` | 作業詳情與我的歷次繳交、草稿、分數、評語；分組作業附上組別與全組的繳交紀錄 |
| `list_materials(course_id)` | 學習活動（教材、作業、影片等）與附件 |
| `download_material(reference_id)` | 下載附件到本機，回傳檔案路徑 |
| `list_exams(course_id)` | 線上考試（唯讀） |
| `get_scores(course_id)` | 考試成績與作業分數 |
| `list_forum_topics(course_id)` / `get_topic(topic_id)` | 討論區主題與回覆 |

**寫入**（會改動 TronClass 上的資料）

| Tool | 說明 |
|---|---|
| `save_homework_draft(activity_id, file_paths, comment?, multiple_choice_title?)` | 上傳本機檔案並存成作業草稿（覆蓋現有草稿，不會繳交） |
| `submit_homework(activity_id, multiple_choice_title?)` | 把草稿正式繳交 |
| `retract_submission(submission_id)` | 撤回已繳交的作業（作業需允許撤回），撤回後變回草稿 |

## 繳交作業的安全設計

- 寫入 tool 的 MCP annotation 標為 destructive，client 通常會在執行前請使用者確認。建議流程：`save_homework_draft` → 用 `get_homework` 確認草稿 → 使用者同意後 `submit_homework`。
- 寫入途中如果 session 過期，該次寫入會被取消，登入後**不會**在背景自動重送，也不會列入「請重新呼叫」的清單，需要重新確認後再執行。
- 上傳只接受絕對路徑的一般檔案，單檔上限 100 MB；拒絕隱藏檔、隱藏目錄（例如 `~/.ssh`、`~/.config`）與 `/etc`、`/dev`、`/proc`、`/sys` 底下的檔案，避免公告或討論區內容誘導模型上傳敏感檔案。
- 上傳後如果存草稿失敗，已上傳的檔案會盡量刪除，不留在「我的資源」。
- 分組作業目前只能查詢，不能存草稿或繳交。

## 隱私

- 帳密只存在本機的 `~/.config/tronclass-mcp/.env`，只會送往海大的 CAS（`tccas.ntou.edu.tw`）。
- 所有請求都直接從你的電腦送到海大的伺服器，沒有經過其他服務。
- 查詢結果會交給你使用的 MCP client 與模型處理。
- log 只寫到 stderr，不會記錄密碼（登入成功時會記錄學號）。

## 限制

- 只支援海大的 TronClass 與 CAS 登入流程。
- tronclass-api 每分鐘最多送 60 個請求，需要排隊超過 20 秒時 tool 會直接回報「請求太頻繁」。
- 唯讀的 API 已在海大實測；繳交作業的寫入流程只用 mock 測試過。詳見 [docs/api-reference.md](docs/api-reference.md) 的「海大實測紀錄」。
- 不提供點名、考試作答等功能。

## 開發

```
src/
  index.ts   MCP server 與所有 tool
  auth.ts    驗證碼登入流程：把 tronclass-api 的 OCR callback 接到 tool 呼叫、重新登入、取消被中斷的請求
docs/
  api-reference.md   TronClass API 研究整理與海大實測紀錄
```

```bash
npm run build   # tsc → dist/
npm start       # 需先設定 TRON_USER / TRON_PASS
```

新增功能時，先在 [tronclass-api](https://github.com/rlongdragon/tronclass-api) 加方法，更新這裡 `package.json` 的依賴，再於 `src/index.ts` 用 `runTool(name, args, op)` 註冊 tool。server 的程式碼不能寫入 stdout（stdio 傳輸使用中），log 請用 `console.error`。

## 授權

ISC。TronClass 為 WisdomGarden 的產品；國立臺灣海洋大學的名稱與相關資料之權利屬各自權利人。
