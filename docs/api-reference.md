# 海大 TronClass API 參考（MCP 用）

> 目標站台：`https://tronclass.ntou.edu.tw`　CAS：`https://tccas.ntou.edu.tw`
> 範圍：**查詢 + 繳交作業**。不含點名、不含考試作答。
> 底層 lib：[rlongdragon/tronclass-api](https://github.com/rlongdragon/tronclass-api)（以下簡稱 **RL**）
> 整理日期：2026-10-12。以下 endpoint 都是從開源專案彙整的，**還沒在海大登入後實測過**。

## 信心標記

| 標記 | 意義 |
|---|---|
| **NTOU✓** | 有海大專案在用（RL、silvercow002/tronclass-script、yd-tw/ind-hackathon） |
| **TW✓** | 在其他台灣學校（輔大、淡江、雲科、亞大）的可用程式碼中出現過 |
| **multi** | 3 個以上 repo 出現過 |
| **1-src** | 只有單一來源，視為未驗證 |
| **RL✅** | 你的 lib 已經包好 |

## 主要來源

| 代號 | Repo | 備註 |
|---|---|---|
| S7 | [seven-317/Tronclass-API](https://github.com/seven-317/Tronclass-API) | TS lib，MIT，亞大 |
| JW | [JasonWu55/tronclass-mcp](https://github.com/JasonWu55/tronclass-mcp) | 輔大 MCP，50+ tools。`docs/tronclass-api-complete.md` 從前端 bundle 撈出 251 個 endpoint |
| RX | [RX5950XT/FJU-TronClass-MCP](https://github.com/RX5950XT/FJU-TronClass-MCP) | 輔大 MCP，`docs/api-reference.md` 2026-08 驗證過 |
| AC | [andyching168/tronclass_control](https://github.com/andyching168/tronclass_control) | 輔大 MCP，含通知類型清單 |
| GQ | [GGQQmax/iclass-mcp](https://github.com/GGQQmax/iclass-mcp) | 淡江 MCP |
| GO | [eWloYW8/zju-courses-go-sdk](https://github.com/eWloYW8/zju-courses-go-sdk) | 浙大，目錄最完整（從官方前端 JS 抽出） |
| ZL | [8eoyw/zju-learning-cli](https://github.com/8eoyw/zju-learning-cli) | 下載的備用路徑、討論區、分頁 |
| CAL | [TW-RF54732/tronclass-calender](https://github.com/TW-RF54732/tronclass-calender) | 雲科，截止日行事曆 |
| YD | [yd-tw/ind-hackathon](https://github.com/yd-tw/ind-hackathon) | **海大**，用到 my-courses、todos、profile |

目前**沒有**專為海大做的 TronClass MCP。最接近的是 JW，但它的 CAS 必須和 TronClass 在同一台主機，海大的 CAS 在另一台主機（tccas），沒辦法直接用。

---

## 1. 登入與 session

### 1.1 CAS 網頁表單 + 驗證碼（NTOU✓，RL 現在的做法）

1. `GET /login?next=/user/index` 會 302 到 `tccas.ntou.edu.tw/cas/login?service=...`。CAS 是 **Apereo/Jasig 3.5 到 4.0 時期的傳統版本**。
2. 表單 `form#fm1` 的欄位：
   - `username`、`password`（明文送出，前端沒有加密）、`captcha`
   - 隱藏欄位：`lt=LT-…`（每次載入頁面都會換）、`execution=e1s1`、`_eventId=submit`、`submit=登錄`
3. 驗證碼來自 `GET https://tccas.ntou.edu.tw/cas/captcha.jpg`：100×50 的 JPEG、**4 位數字**，**跟 CAS 的 `JSESSIONID` 綁定**，所以抓圖片和送表單必須用同一個 cookie jar。
4. 送出表單後跟著 redirect 走。回應內容如果有 `forget-password` 就是登入失敗（驗證碼錯和密碼錯是同一個頁面，分不出來）。
5. 登入成功時，TronClass 會設定 `session` cookie。

帳號密碼很可能就是 AIS 帳密：CAS 頁面寫「使用教務系統帳號」，忘記密碼也連到 AIS。

**驗證碼的處理方式（2026-10-12 決定）**：MVP 先把驗證碼圖片交給 MCP client 的 agent 看。之後如果出問題，可以改用：
- §1.2 的 REST 登入，完全不需要驗證碼
- 本機 OCR：用 ddddocr 的 `common_old.onnx` 搭配 `onnxruntime-node` 和 `sharp`，限定只辨識數字。前處理可以參考 ntou-tat 的 `src/utils/ocr.ts`

### 1.2 CAS REST，不需要驗證碼（⚠️ 在海大**未驗證**）

1. `POST https://tccas.ntou.edu.tw/cas/v1/tickets`，以 form 格式送 `username,password`。成功會回 201，header `Location: …/TGT-…`。如果 URL 是 `http://`，要改成 `https://`。
2. `POST {TGT url}`，帶 `service=https://tronclass.ntou.edu.tw/api/cas-login`，回傳純文字 `ST-…`。
3. `GET /api/cas-login?ticket=ST-…`，回傳 JSON `{user_id,…}` 和 `X-SESSION-ID` header。

目前已知的只有：`GET /cas/v1/tickets` 回 405，`Allow: POST`，代表這個 endpoint 存在。至於它接不接受學生帳號、海大有沒有允許 `/api/cas-login` 這個 service，都還不知道。這是 JW 和 AC 在輔大用的方式。

### 1.3 session

- cookie 名稱是 `session=V2-…`。每個回應的 **`X-SESSION-ID`** header 都會帶同樣的值。
- 打 `/api/*` 時，可以用 cookie，也可以只帶 `X-SESSION-ID` header（YD 在海大是這樣用的）。
- **這個值會換**，每次都要存回應裡最新的 `X-SESSION-ID`。
- **在海大，session 失效時 `/api/*` 會回 302 導到 tccas**，不是 401。請求時要用 `redirect: 'manual'`，再檢查 `Location` 是不是指向 `tccas.ntou.edu.tw`。輔大回的是 401，兩種情況都要處理。
- 輔大的 session 是 24 小時滑動過期，每次成功呼叫都會延長。海大還沒實測。

### 1.4 建議的 header

```
Accept: application/json, text/plain, */*
X-Requested-With: XMLHttpRequest
User-Agent: <一般瀏覽器 UA，不要用函式庫預設的 UA>
```

---

## 2. 共通規則

- **分頁**：`page`（從 1 開始）、`page_size`，回應裡有 `pages`，有時也有 `total`。**一定要翻到 `page >= pages` 為止**。例如 `homework-activities` 在輔大預設每頁只有 10 筆。通知用的是 `offset`/`limit`。
- **`conditions`**：把 JSON 物件 URL-encode 後當成 query 參數，例如 `conditions={"status":["ongoing"],"keyword":""}`。
- **`fields`**：指定要回傳哪些欄位，可以巢狀，例如 `fields=id,name,instructors(id,name)`。
- **`no-intercept=true`**：網頁前端會加的旗標，加了也沒影響。
- **時間**：ISO-8601 UTC（結尾是 `Z`），顯示時要轉成 Asia/Taipei。
- **速率**：伺服器沒有公開限制。RL 和 S7 自己限制在每分鐘 60 次，空中大學在考試高峰時會回 429。5xx 錯誤用 1s、2s、4s 退避重試。
- **自己的 user id**：從 `GET /api/profile` 的 `id` 拿。後面的 submission 和 `/ntf` 都需要它。

---

## 3. 使用者

| Method | Path | 說明 | 信心 | RL |
|---|---|---|---|---|
| GET | `/api/profile` | 目前登入的使用者：`id,name,email,user_no,department{name}` | NTOU✓ multi | |
| GET | `/api/my-semesters?fields=id,name,sort,academic_year_id,is_active,code` | `semesters[]` | TW✓ | |
| GET | `/api/my-academic-years` | `academic_years[]` | TW✓ | |

## 4. 課程

| Method | Path | 說明 | 信心 | RL |
|---|---|---|---|---|
| GET | `/api/my-courses?conditions=…&fields=…&page&page_size` | `conditions={"status":["ongoing","notStarted","closed"],"keyword":""}`。回傳 `{courses[{id,name,course_code,display_name,semester_id,instructors,start_date,end_date,credit}], pages}` | NTOU✓ multi | ✅（但 conditions 沒傳出去） |
| GET | `/api/user/recently-visited-courses` | `visited_courses[]` | NTOU✓ | ✅ |
| GET | `/api/courses/{cid}[?fields=…]` | 課程詳情 | TW✓ multi | |
| GET | `/api/courses/{cid}/modules` | 週次／章節 `modules[{id,name,sort,hidden}]` | TW✓ multi | |
| GET | `/api/courses/{cid}/outline` | 課綱 | TW✓ | |
| GET | `/api/course/{cid}/my-completeness` | 自己的學習完成度 | multi | |

## 5. 活動、教材、下載

活動的 `type` 有：`material, online_video, homework, forum, web_link, page, questionnaire, slide, lesson, scorm, chatroom, survey, classroom`。

| Method | Path | 說明 | 信心 | RL |
|---|---|---|---|---|
| GET | `/api/courses/{cid}/activities?sub_course_id=0` | 課程內所有活動：`activities[{id,title,type,module_id,start_time,end_time,uploads[],data{description,content,link}}]` | TW✓ multi | |
| GET | `/api/activities/{aid}` | 活動詳情：`uploads[{id,name,size,reference_id,allow_download}]`、`data.*`、`end_time` | TW✓ multi | |
| GET | `/api/activities/{aid}/upload_references` | `references[{id,name,upload{id,allow_download}}]` | multi | |
| GET | `/api/uploads/reference/{reference_id}/blob` | **一般下載**。檔名從 `Content-Disposition: filename*=UTF-8''…` 取 | TW✓ multi | |
| GET | `/api/uploads/{upload_id}/blob` | 下載原始檔（備用路徑） | multi | |
| GET | `/api/uploads/{upload_id}/url` | `{url}` 暫時有效的簽名網址，遇到 403 就重新拿一次 | TW✓ | |
| GET | `/api/uploads/reference/document/{reference_id}/url?preview=true` | 轉檔後的預覽 PDF（`allow_download=false` 時也拿得到） | multi | |
| GET | `/api/user/resources?conditions=…&page&page_size` | 個人雲端檔案 | TW✓ | |

## 6. 作業

### 6.1 查詢

| Method | Path | 說明 | 信心 | RL |
|---|---|---|---|---|
| GET | `/api/courses/{cid}/homework-activities?page&page_size` | **有分頁**。`{homework_activities[{id,title,start_time,end_time,score,score_published,uploads[],submitted}], pages, total}` | NTOU✓ | ✅（但沒處理分頁） |
| GET | `/api/activities/{aid}` | 作業詳情。`/api/courses/{cid}/homework-activities/{aid}` 在輔大會回 404，要用這個 | TW✓ | |
| GET | `/api/course/activities/{aid}/students/{uid}/submission` | 自己目前的繳交：`created_at` 是 null 代表還沒交，另有 `final_score`、`score` | TW✓ | |
| GET | `/api/activities/{aid}/students/{uid}/submission_list` | 歷次繳交 `list[{score,comment,instructor_comment,submitted_at,uploads}]` | TW✓ multi | |
| GET | `/api/course/{cid}/homework/submission-status` | 整門課每份作業的繳交狀態 | multi | |

### 6.2 繳交

這一節的資料有兩個來源：
- 海大前端的公開 JS bundle：`https://tronclass.ntou.edu.tw/static/…`，共 726 個 chunk。
- RX 的 draft 流程：2026-09-22 在輔大做過端到端測試。

海大和輔大的前端 chunk ID 一樣（`js-56834` preUpload、`js-88788` save），可以確定是同一套程式碼。

信心標記：**B** = 在海大 bundle 裡看到，**V** = 有 client 實測過，**C** = 只在其他 client 的程式碼看到，**I** = 推測。

| # | 步驟 | Method / Path | Request | Response | 信心 |
|---|---|---|---|---|---|
| 0 | 取得 uid | `GET /api/profile` | – | `{id,…}` | V |
| 1 | 作業詳情 | `GET /api/activities/{aid}?sub_course_id=0` | – | 作業物件（欄位見下方） | B C |
| 2 | 現有的繳交和草稿 | `GET /api/activities/{aid}/students/{uid}/submission_list` | – | `{list:[…]}`。`is_draft:true` 的那筆是草稿，`is_latest_version:true` 的是目前版本 | B V |
| 2g | （分組作業） | 先 `GET /api/group-sets/{group_set_id}/group` 取得 `{group:{id}}`，再 `GET /api/activities/{aid}/groups/{gid}/submission_list` | – | 同上 | B |
| 3 | 登記上傳（preUpload） | `POST /api/uploads`，JSON | `{"name","size","parent_type":null,"parent_id":0,"is_scorm":false,"is_wmpkg":false,"source":"","is_marked_attachment":false,"embed_material_type":""}` | **201** `{id,name,status,upload_url,storage_type,transcoder,…}` | B V |
| 4a | 上傳檔案本體（一般情況，例如 `storage_type="MEDIA"`） | `PUT {upload_url}`，**multipart/form-data**，欄位名稱 `file` | 檔案 | `{file_key}` | B V |
| 4b | 上傳檔案本體（`storage_type=="S3" && transcoder=="WRPC"`） | 用 raw body `PUT {upload_url}`，`Content-Type` 設成檔案的 MIME，再 `POST /internal-api/upload/callback/{id}`，body 是 `{"file_key":id}` | – | – | B |
| 4c | 上傳檔案本體（`storage_type=="QINIU"`） | `GET /api/uptoken?id={id}`，接著 `POST {upload_url}/mkblk/{size}`，再 `POST …/mkfile/{size}` | – | – | B |
| 5 | （可選）等檔案處理完 | 重複 `GET /api/uploads/{id}`，直到 `status=="ready"` | – | – | V |
| 6 | 存草稿或正式送出 | **還沒有草稿**：`POST /api/course/activities/{aid}/submissions`<br>**已經有草稿**：對同一個 path 用 `PUT`，body 多加 `submission_id:<draft_id>` | `{"comment":"<html>","uploads":[ids],"slides":[],"is_draft":bool,"mode":data.mode 或 "normal","other_resources":[],"uploads_in_rich_text":[]}`<br>`mode=="multiple"` 時要再加 `multiple_choice_title` | 201/200 `{submission:{id,…}, message}`<br>錯誤時是 `{message, errors:{…}}` | B V |
| 7 | 確認結果 | 再做一次步驟 2；也可以打 `GET /api/submissions/{aid}/count` | – | `{submission_count}` | B |
| R | 撤回 | `PUT /api/submissions/{submission_id}/retract`，沒有 body | – | 失敗時回 `{code:40001}`。撤回後會變回草稿 | B |
| D | 刪除已上傳的檔案 | `DELETE /api/uploads/{id}` | – | – | B V |

**網頁版正式送出的做法**：如果已經有草稿，就用 `PUT` 帶上 `submission_id=draft_id` 和 `is_draft:false`，把草稿轉成正式繳交。草稿沒有刪除用的 endpoint，只能覆蓋。

`comment` 可以是純文字，也可以是 `<p>…</p>` 這種 HTML。

#### 作業詳情的欄位（步驟 1）

| 用途 | 欄位 |
|---|---|
| 時間與狀態 | `start_time`、`end_time`、`deadline`、`is_closed`、`is_in_progress` |
| 分組 | `submit_by_group`、`group_set_id`、`group_id` |
| 可繳交次數 | `submit_times`（或 `data.submit_times`）、`non_submit_times`（true 表示不限次數）、`user_submit_count` |
| 補交與重交 | `need_make_up`、`is_resubmit_open` |
| 內容 | `uploads`（老師附的檔案）、`data.description`、`data.mode`（`normal` 或 `multiple`） |
| 撤回 | `data.allow_retract`（預設是 true） |
| 成績公布 | `data.announce_score_type`、`announce_score_time` |

#### 什麼時候可以繳交（bundle 裡的 `canSubmitHomework`，B）

符合以下**任一條件**就可以繳交：
- `is_in_progress` 為 true，而且次數還沒用完：`non_submit_times` 為 true，或已繳交次數（`marked_submitted` 的筆數）小於 `submit_times`。
- 有一筆開放中、還沒用過的補交紀錄：`GET /api/homework/{aid}/students/{uid}/make-up-record`。
- 開放重交而且還沒用過：`GET /api/homework/{aid}/students/{uid}/resubmit-record`。

會被擋下的情況：最新一筆繳交的 `recommend==1`，或是分組作業但自己沒有 `group_id`。

注意：**沒有「允許遲交」這個設定**。超過 `end_time` 之後，只能透過補交或重交。

#### 檔案限制

- 單份作業**沒有**檔案類型、數量、大小的限制。
- 全校的副檔名白名單：`GET /org/global-config`（不用登入）的 `upload_extension_format_allowlist`。
  - **白名單裡有**：pdf、doc/docx、ppt/pptx、xls/xlsx、zip、rar、tar、txt、md、c、m、ipynb、jpg、png、mp4 等等。
  - ⚠️ **白名單裡沒有**：`py`、`java`、`cpp`、`h`。要交這些檔案，建議先壓成 zip。
  - 前端只有在 `isFileExtensionCheckEnable` 打開時才會檢查。伺服器端會不會擋還不知道（I）。
- 大小上限寫在伺服器端渲染的模板裡，沒有找到具體數字。
- 上傳的檔案會放進「我的資源」（因為 `parent_id:0`），可能會佔用個人的儲存空間（I）。

#### 讀回繳交結果、分數和評語

`submission_list` 每一筆的欄位：`id, comment, uploads[], created_at, submitted_at, is_draft, is_latest_version, is_redo, is_resubmitted, marked_submitted, can_retract, score, final_score, instructor_comment, submission_correct{comment, instructor_score, score, uploads[]}`。

其他相關 endpoint：
- `GET /api/activities/{aid}/students/{uid}/homework-score`
- `GET /api/submissions/{sid}/marked_attachments`（老師批改過的附件）

#### header 與 CSRF

- **不需要 CSRF token**：海大只設定 `session`（SameSite=Lax），沒有 `XSRF-TOKEN` cookie；前端送出時也沒加特別的 header。
- 建議帶上 `Content-Type: application/json`。也可以加 `Origin`/`Referer: https://tronclass.ntou.edu.tw/`。
- ⚠️ **`PUT upload_url` 不要帶 session cookie**。這個 URL 可能在別的主機，而且本身就帶有 token。

#### 不要用的做法

| 做法 | 原因 |
|---|---|
| S7 的 `submitHomework` | 只送 `{content}`，根本沒附檔案 |
| JW 的 `POST /api/course/activities/{aid}/students/{uid}/submission` | 在 bundle 的學生流程裡找不到 |
| `/api/activities/{id}/submissions`（yzy1232） | 猜的 |
| `PUT /api/uploads/{id}/uploaded` | 只用在 CC 影片上傳 |

來源：
- 海大 bundle：`88788.f8520ecb.js`（存檔、撤回、能否繳交的判斷）、`2562.122fcbdf.js`（homeworkApi）、`82199-60c7cd78.js`（上傳）、`56834-ae6f2a2f.js`（preUpload、callback）
- 其他 repo：[RX](https://github.com/RX5950XT/FJU-TronClass-MCP)（`services/homework.py`、`tests/unit/test_homework_submission.py`）、zhou-haoyang/tronclass-cli、xzzd-pro/xzzd-pro、CrazySpottedDove/fiz、GGQQmax/iclass-cli、yeliqin666/xjtu-toolbox-android（`LmsApi.kt`）

## 7. 待辦

| Method | Path | 說明 | 信心 | RL |
|---|---|---|---|---|
| GET | `/api/todos` | `todo_list[{id(=activity id),title,type,course_id,course_name,course_code,start_time,end_time,is_locked}]` | NTOU✓ multi | ✅ |

**做成截止日清單的方法**（CAL）：先拿 `my-courses`，再對每一門課查 `activities` 和 `exam-list`，最後合併。

## 8. 公告與通知

| Method | Path | 說明 | 信心 | RL |
|---|---|---|---|---|
| GET | `/api/course-bulletins?conditions={"start_date":"","end_date":"","keyword":"","course_ids":[…]}&page&page_size` | **一次取得所有課的課程公告**。`course_ids` 可以篩選特定課程，日期留空代表不限。`{bulletins[{id,title,content(HTML),course_id,created_at,created_by,uploads[]}], pages}` | TW✓ multi | |
| GET | `/api/courses/{cid}/bulletins?conditions={"start_date":"","end_date":"","keyword":""}` | 單一課程的公告 | TW✓ | |
| GET | `/api/org-bulletin/bulletins?page&page_size&conditions={}` | 全校公告 | TW✓ | |
| GET | `/ntf/users/{uid}/notifications?offset=0&limit=20&additionalFields=unread_count&types=…` | **前綴是 `/ntf`，不是 `/api`**。`{notifications[{id,type,unread,timestamp,payload{course_name,activity_title,bulletin_title,end_time…}}], unread_count}` | TW✓ | |
| GET | `/ntf/users/{uid}/notifications/unread-count` | `{unread_count}` | TW✓ 1-src | |

通知的 `types`：
- 公告：`bulletin_created`、`bulletin_updated`
- 作業：`homework_opened_for_submission`、`homework_expiring`、`homework_ended`、`homework_submitted`
- 考試：`exam_opened`、`exam_score_updated`、`exam_ended`
- 課程：`course_started`
- 討論區：`topic_create`、`topic_replies`

## 9. 成績與考試（唯讀）

| Method | Path | 說明 | 信心 |
|---|---|---|---|
| GET | `/api/courses/{cid}/exam-scores` | `exam_scores[{activity_id,score}]` | TW✓ multi |
| GET | `/api/courses/{cid}/exam-list?page&page_size=20` | `{exams[], pages}`，有截止時間和作答時限 | TW✓ |
| GET | `/api/exams/{eid}` | 考試資訊（題數、配分、可作答次數） | TW✓ |
| GET | `/api/exams/{eid}/submissions` | 自己的作答紀錄和分數 | TW✓ |
| GET | `/api/courses/{cid}/score-items` | 成績組成（名稱、比例） | TW✓ 1-src |

學生權限通常拿不到單項成績明細，可以改用作業的 `score`/`score_published`、submission 的 `final_score`，或考試的 `submissions`。

## 10. 討論區（唯讀，第二階段）

| Method | Path | 說明 | 信心 |
|---|---|---|---|
| GET | `/api/courses/{cid}/topic-categories` | 討論區活動對應的分類 | TW✓ multi |
| GET | `/api/forum/categories/{cat_id}?page&page_size=50` | `{result:{topics[], pages}}` | TW✓ multi |
| GET | `/api/topics/{tid}` | 主題和回覆 | TW✓ multi |

---

## 11. 不要做的 endpoint

| Endpoint | 原因 |
|---|---|
| `GET /api/exams/{eid}/distribute` | 會發出考卷，可能直接產生一份作答紀錄 |
| `POST /api/exams/{eid}/submissions/storage` | **會用掉一次作答機會** |
| 從 `/api/course/{cid}/activity-reads-for-user` 的 `data.score` 讀成績 | 可能讀到老師**還沒公布**的分數（「偷看成績」），只能用已公布的分數 |
| `POST /api/course/activities-read/{aid}` | 會寫入觀看進度，也就是刷完成度 |
| `/api/radar/rollcalls`、`/api/rollcall/*` | 點名不在範圍內 |

---

## 12. MCP tool 草案

| 階段 | Tool | 對應 endpoint | 備註 |
|---|---|---|---|
| P0 | `login_begin` | `/login` → `captcha.jpg` | 回傳驗證碼圖片（image content） |
| P0 | `login_submit(code)` | CAS POST | 失敗時直接附上一張新的驗證碼 |
| P0 | `whoami` | `/api/profile` | 順便把 uid 存起來 |
| P0 | `list_courses(status?)` | `/api/my-courses` | 預設只列 `ongoing` |
| P0 | `list_todos()` | `/api/todos` | |
| P0 | `list_announcements(course_id?, since?, keyword?)` | `/api/course-bulletins` | HTML 轉成純文字 |
| P0 | `list_homework(course_id?)` | `homework-activities`（自動翻頁） | 不指定課程時就跑過所有課 |
| P0 | `get_homework(activity_id)` | `/api/activities/{aid}` + `…/submission` | 含自己的繳交狀態 |
| P1 | `save_homework_draft(activity_id, files[], comment?)` | §6.2 步驟 1→6（`is_draft:true`） | 寫入操作，但可以重複覆蓋，相對安全。上傳前先檢查副檔名白名單 |
| P1 | `submit_homework(activity_id)` | §6.2 步驟 6（用 PUT 把草稿轉成 `is_draft:false`），再做步驟 7 確認 | **正式繳交**，MCP 要標成 destructive。送出前要告訴使用者能不能撤回（看 `allow_retract`/`can_retract`）和剩幾次可交 |
| P1 | `retract_submission(submission_id)` | §6.2 步驟 R | 只有 `can_retract` 為 true 時才能用 |
| P1 | `list_course_activities(course_id, type?)` | `/api/courses/{cid}/activities` | |
| P1 | `download_file(reference_id, dest_dir)` | `/api/uploads/reference/{rid}/blob` | 寫到本機，回傳檔案路徑 |
| P1 | `list_notifications(unread_only?)` | `/ntf/users/{uid}/notifications` | |
| P2 | `get_scores(course_id)` | `exam-scores` + 作業的 `score_published` | 只顯示已公布的 |
| P2 | `list_exams(course_id)` | `exam-list` | 唯讀 |
| P2 | `list_school_announcements()` | `/api/org-bulletin/bulletins` | |
| P2 | `list_topics` / `get_topic` | §10 | |
| P2 | `raw_get(path)` | 任意 GET | 只開放 GET，把 §11 列的 path 擋掉 |

帳號密碼從環境變數讀（例如 `TRON_USER`/`TRON_PASS`），**不要當成 tool 參數傳**。

---

## 13. RL（tronclass-api）要先修的地方

✅ = 已在 branch `fix/mcp-readiness` 修正（`e7623fa`、`544942b`、`26371ff`）。

| # | 問題 | 位置 |
|---|---|---|
| 1 ✅ | `console.log` 會寫進 stdout，**弄壞 MCP stdio 傳輸**，而且會印出帳號 | `src/index.ts:157`、`:178` |
| 2 ✅ | `src/types/index.ts` 沒 commit，重新 clone 後 build 會失敗 | `src/index.ts:2-8` |
| 3 ✅ | 偵測不到 session 過期：`loggedIn` 不會被設回 false，也沒檢查導向 tccas 的 302 | `call()` `:236-283` |
| 4 | 沒更新 `X-SESSION-ID` | `fetcher` |
| 5 | 驗證碼錯會被當成密碼錯；OCR 結果不是 4 位數字時直接 return，沒有重試 | `:133-139`、`:170` |
| 6 | `myCourses` 的參數沒用到 | `:297-305` |
| 7 | `homework-activities` 沒處理分頁 | `:307-315` |
| 8 | 速率限制超過時直接丟錯，應該改成 await 等待 | `rateLimiter()` |
| 9 | 沒檢查 `res.ok` | 所有 API 方法 |
| 10 | `login()` 用 `.split(".tw/")` 推算 CAS 網址；只服務海大的話，直接寫死 `tccas.ntou.edu.tw` 就好 | `:108` |

可以從 S7 借用的部分（MIT，記得保留授權聲明）：錯誤類別分層、`getJson` 檢查 `res.ok`、指數退避重試、自動翻頁加上限、下載時解析 `Content-Disposition`。
