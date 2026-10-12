# tronclass-mcp

海大 TronClass（`https://tronclass.ntou.edu.tw`）的 MCP server。

這個專案只負責把 [tronclass-api](https://github.com/rlongdragon/tronclass-api) 包成 MCP tool，登入、session 與 API 呼叫都由 tronclass-api 處理。要新增功能時，先在 tronclass-api 加方法，再到這裡加對應的 tool。

## Tools

| Tool | 說明 |
|---|---|
| `login` | 開始登入，回傳 4 位數字驗證碼圖片 |
| `submit_captcha(code)` | 送出驗證碼完成登入 |
| `list_todos` | 待辦事項 |
| `list_courses` | 我的課程（含課程 ID） |
| `list_recent_courses` | 最近瀏覽的課程 |
| `list_homework(course_id)` | 某門課的作業 |
| `list_materials(course_id)` | 某門課的學習活動（教材、作業、影片等）與附件 |
| `download_material(reference_id)` | 下載附件到本機，回傳檔案路徑 |

時間欄位都是 UTC。

## 登入流程

CAS 登入頁需要 4 位數字的圖片驗證碼，這裡交給 MCP client 端的模型辨識：

1. 任何 tool 在還沒登入、或 session 過期需要重新登入時，會回傳驗證碼圖片。
2. 模型辨識後呼叫 `submit_captcha`。
3. 登入成功後，重新呼叫剛才的 tool。

驗證碼錯誤時會自動回傳新的驗證碼；連續失敗 3 次會停下來，確認帳密後再呼叫 `login`。

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
