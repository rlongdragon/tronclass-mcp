#!/usr/bin/env node
import {
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
  sep,
} from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ApiError,
  RateLimitError,
  type Activity,
  type Bulletin,
  type CreatedUpload,
  type Group,
  type loginResponse,
  type Submission,
  type Upload,
} from "tronclass-api";
import { z } from "zod";
import {
  Auth,
  MAX_CAPTCHA_FAILURES,
  type AuthEvent,
  type LoginStop,
  type RunResult,
} from "./auth.js";

const username = process.env.TRON_USER;
const password = process.env.TRON_PASS;
const baseUrl = process.env.TRON_BASE_URL ?? "https://tronclass.ntou.edu.tw";
const downloadDir =
  process.env.TRON_DOWNLOAD_DIR ?? join(homedir(), "Downloads", "tronclass");

if (!username || !password) {
  console.error("請在 MCP server 的 env 設定 TRON_USER 與 TRON_PASS。");
  process.exit(1);
}

// 保存 session 的檔案，重啟後沿用以減少登入；設成空字串可停用
const sessionFile =
  process.env.TRON_SESSION_FILE ??
  join(homedir(), ".config", "tronclass-mcp", "session.json");

const auth = new Auth(username, password, baseUrl);
const tron = auth.tron;
// lib 預設超過速率限制時一直排隊；tool 呼叫不宜卡太久，要等超過 20 秒就回報錯誤
tron.rateLimitMaxWaitMs = 20_000;

let savedSession: string | undefined;

// 還原上次保存的 session（同一個帳號才沿用）；檔案不存在或格式不對就照常登入
if (sessionFile) {
  try {
    const saved = JSON.parse(await readFile(sessionFile, "utf8"));
    if (saved.username === username && typeof saved.cookies === "string") {
      await auth.restoreSession(saved.cookies);
      savedSession = await tron.exportSession();
    }
  } catch {}
}

// session 有變動時寫回檔案；內容等同登入憑證，權限設為只有自己能讀
async function saveSession() {
  if (!sessionFile || !auth.ready) return;
  try {
    const cookies = await tron.exportSession();
    if (cookies === savedSession) return;
    await mkdir(dirname(sessionFile), { recursive: true, mode: 0o700 });
    const tmp = `${sessionFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ username, cookies }), { mode: 0o600 });
    await rename(tmp, sessionFile);
    savedSession = cookies;
  } catch (e) {
    console.error(`無法保存 session：${e instanceof Error ? e.message : e}`);
  }
}

const text = (t: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text: t }],
  ...(isError && { isError: true }),
});

const errorText = (e: unknown) => text(e instanceof Error ? e.message : String(e), true);

const captchaResult = (image: string, message: string): CallToolResult => ({
  content: [
    {
      type: "text",
      text: `${message}\n請辨識圖片中的 4 位數字驗證碼，然後呼叫 submit_captcha。`,
    },
    { type: "image", data: image, mimeType: "image/jpeg" },
  ],
});

const stoppedResult = (stop: LoginStop) =>
  text(
    stop.reason === "captcha"
      ? `驗證碼連續錯誤 ${MAX_CAPTCHA_FAILURES} 次，已停止自動登入。請稍後再呼叫 login。`
      : `帳號或密碼錯誤：${stop.message}。請檢查 ~/.config/tronclass-mcp/.env 後再呼叫 login。`,
    true
  );

// 驗證碼錯誤時自動換一張新的驗證碼；帳密錯誤（不重試，避免帳號被鎖）或驗證碼連續錯太多次就停下來；
// 其他失敗（網路、速率限制等）只回報，不自動重試
async function loginFailed(result: loginResponse): Promise<CallToolResult> {
  const stop = auth.stopped;
  if (stop) return stoppedResult(stop);
  if (result.reason !== "captcha") {
    return text(`登入失敗：${result.message}。請稍後再試，或呼叫 login 重新登入。`, true);
  }
  return authEventResult(
    await auth.begin(),
    `驗證碼錯誤（${result.message}），已換一張新的驗證碼。`
  );
}

const timeoutResult = () =>
  text("TronClass 登入頁沒有回應，登入仍在背景進行，請稍後再呼叫 login。", true);

async function authEventResult(
  event: AuthEvent,
  captchaMessage: string
): Promise<CallToolResult> {
  if (event.type === "timeout") return timeoutResult();
  if (event.type === "captcha") return captchaResult(event.image, captchaMessage);
  if (event.result.success) {
    await saveSession();
    const retry = [...toolsToRetry];
    toolsToRetry.clear();
    return text(
      retry.length ? `登入成功。請重新呼叫：${retry.join("、")}` : "登入成功。"
    );
  }
  return loginFailed(event.result);
}

// 因需要登入而沒有完成的 tool 呼叫，登入成功後提示 agent 重新呼叫；寫入類 tool 不列入，要重新向使用者確認
const toolsToRetry = new Set<string>();
const writeTools = new Set(["save_homework_draft", "submit_homework", "retract_submission"]);

async function runTool<T>(
  name: string,
  args: Record<string, unknown>,
  op: () => Promise<T>
): Promise<CallToolResult> {
  let result: RunResult<T>;
  try {
    result = await auth.run(op);
  } catch (e) {
    if (e instanceof RateLimitError) {
      return text(`請求太頻繁，請等 ${Math.ceil(e.waitTime / 1000)} 秒後再試。`, true);
    }
    // lib 的 ApiError 訊息已含 endpoint、狀態碼與回應開頭
    return errorText(e);
  }
  const write = writeTools.has(name);
  if (result.type !== "ok" && !write) {
    toolsToRetry.add(
      Object.keys(args).length ? `${name}(${JSON.stringify(args)})` : name
    );
  }
  if (result.type === "timeout") return timeoutResult();
  if (result.type === "captcha") {
    return captchaResult(
      result.image,
      write
        ? `需要登入 TronClass，${name} 沒有執行。登入後不會自動重做，請先向使用者確認後再重新呼叫 ${name}。`
        : "需要登入 TronClass。"
    );
  }
  if (result.type === "login-failed") return loginFailed(result.result);
  await saveSession();
  // lib 在回應缺少預期的 key 時會回傳 undefined，而 JSON.stringify(undefined) 不是字串
  return text(JSON.stringify(result.value ?? null));
}

// 目前使用者的 id（通知與繳交紀錄需要），第一次用到時才查 profile；需在 runTool 的 op 內呼叫
let userId: number | undefined;
const getUserId = async () => (userId ??= (await tron.profile()).id);

// 公告、討論區等 HTML 內容轉成純文字；不是字串時回傳 undefined
const entities: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'",
};
function htmlToText(html: unknown): string | undefined {
  if (typeof html !== "string") return undefined;
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    // 一次解完，避免 &amp;lt; 被解兩次
    .replace(/&(?:(nbsp|amp|lt|gt|quot|#39|apos)|#(\d+)|#x([0-9a-f]+));/gi, (m, name, dec, hex) => {
      if (name) return entities[name.toLowerCase()];
      const code = dec ? Number(dec) : parseInt(hex, 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .join("\n");
}

// 只取物件中有值的欄位
const pick = (o: Record<string, unknown> | undefined, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => o?.[k] != null).map((k) => [k, o![k]]));

const attachments = (uploads?: Upload[]) =>
  (uploads ?? []).map((u) => ({ reference_id: u.reference_id, name: u.name }));

const bulletin = (b: Bulletin) => ({
  id: b.id,
  title: b.title,
  course_id: b.course_id,
  created_at: b.created_at,
  author: b.created_by?.name,
  content: htmlToText(b.content),
  attachments: attachments(b.uploads),
});

const submission = (s: Submission) => ({
  id: s.id,
  is_draft: s.is_draft,
  is_latest_version: s.is_latest_version,
  submitted_at: s.submitted_at,
  created_at: s.created_at,
  score: s.score,
  final_score: s.final_score,
  instructor_comment: htmlToText(s.instructor_comment),
  can_retract: s.can_retract,
  comment: htmlToText(s.comment),
  files: (s.uploads ?? []).map((u) => ({ id: u.id, name: u.name })),
});

const submissionsOf = async (activityId: number) =>
  (await tron.getSubmissionList(activityId, await getUserId())) ?? [];

// 我在某個分組集合的組別；不在任何組時為 undefined
const myGroupIn = (groupSetId: number) =>
  tron.getMyGroup(groupSetId).catch((e) => {
    if (e instanceof ApiError && e.status === 404) return undefined;
    throw e;
  });

const groupInfo = (g: Group, me: number) => ({
  id: g.id,
  name: g.name,
  members: (g.group_users ?? []).map((u) => ({
    name: u.name,
    user_no: u.user_no,
    is_leader: g.leaders?.includes(u.id) ?? false,
    is_me: u.id === me,
  })),
});

// mode 為 multiple 的作業可選的題目（activity.data.multiple_choice[].title）
const choiceTitles = (a: Activity) => {
  const choices = a.data?.multiple_choice;
  return Array.isArray(choices) ? choices.map((c) => c?.title) : undefined;
};

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

const multipleChoiceTitle = z
  .string()
  .optional()
  .describe("作業 mode 為 multiple 時必填：選擇的題目，可從 get_homework 的 multiple_choice_titles 取得");

// 依副檔名猜上傳檔案的 Content-Type
const contentTypes: Record<string, string> = {
  pdf: "application/pdf",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain",
  md: "text/markdown",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  ipynb: "application/x-ipynb+json",
  c: "text/x-c",
};

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const BLOCKED_DIRS = ["/dev", "/proc", "/sys", "/etc"];

// 讀取要上傳的本機檔案。擋掉隱藏檔／隱藏目錄（例如 ~/.ssh、~/.config）與系統目錄，
// 給的路徑與 symlink 解析後的實際路徑都要檢查，避免把敏感檔案交出去
async function readLocalFile(path: string) {
  if (!isAbsolute(path)) throw new Error(`請提供絕對路徑：${path}`);
  const real = await realpath(path).catch((e: NodeJS.ErrnoException) => {
    throw new Error(`讀不到檔案 ${path}（${e.code ?? e.message}）`);
  });
  for (const p of [resolve(path), real]) {
    if (p.split(sep).some((part) => part.startsWith("."))) {
      throw new Error(`不能上傳隱藏檔或隱藏目錄中的檔案：${path}`);
    }
    if (BLOCKED_DIRS.some((dir) => p === dir || p.startsWith(dir + sep))) {
      throw new Error(`不能上傳系統目錄中的檔案：${path}`);
    }
  }
  const info = await stat(real);
  if (!info.isFile()) throw new Error(`不是一般檔案：${path}`);
  if (info.size > MAX_UPLOAD_BYTES) throw new Error(`檔案超過 100 MB：${path}`);
  const type = contentTypes[extname(real).slice(1).toLowerCase()];
  return {
    name: basename(path),
    data: await readFile(real),
    type: type ?? "application/octet-stream",
  };
}

const rejectGroupHomework = (a: Activity) => {
  if (a.submit_by_group) throw new Error("分組作業目前不支援存草稿或繳交，請到 TronClass 網頁操作。");
};

const courseId = z.number().int().describe("課程 ID，可從 list_courses 取得");
const activityId = z
  .number()
  .int()
  .describe("作業的 activity ID，可從 list_homework 或 list_todos 取得");
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();

const server = new McpServer({ name: "tronclass-ntou", version: "0.1.0" });

server.registerTool(
  "login",
  {
    title: "登入 TronClass",
    description:
      "登入海大 TronClass。通常直接用帳密完成登入，不需要驗證碼；其他 tool 在需要時也會自動登入。只有免驗證碼登入無法使用時才會回傳 4 位數字驗證碼圖片，辨識後呼叫 submit_captcha。自動登入因帳密錯誤或驗證碼連續錯誤而停止後，也用這個 tool 重新開始。",
  },
  async () => {
    if (auth.ready) return text("已經登入。");
    auth.resetFailures();
    return authEventResult(await auth.begin(), "需要登入 TronClass。");
  }
);

server.registerTool(
  "submit_captcha",
  {
    title: "送出驗證碼",
    description: "送出驗證碼圖片中的 4 位數字以完成登入。",
    inputSchema: { code: z.string().describe("驗證碼圖片中的 4 位數字") },
  },
  async ({ code }) => {
    try {
      // lib 在驗證碼錯誤時會自己換一張，所以這裡收到驗證碼就代表剛才的驗證碼錯了
      const event = await auth.submit(code.trim());
      const stop = auth.stopped;
      if (stop) return stoppedResult(stop);
      return await authEventResult(
        event,
        event.type === "captcha" && event.expired
          ? "驗證碼已過期，已換一張新的驗證碼。"
          : "驗證碼錯誤，已換一張新的驗證碼。"
      );
    } catch (e) {
      return errorText(e);
    }
  }
);

server.registerTool(
  "whoami",
  {
    title: "目前使用者",
    description: "目前登入的 TronClass 使用者：id、姓名、學號、系所。",
    annotations: { readOnlyHint: true },
  },
  () =>
    runTool("whoami", {}, async () => {
      const p = await tron.profile();
      userId = p.id;
      return { id: p.id, name: p.name, user_no: p.user_no, department: p.department?.name };
    })
);

server.registerTool(
  "list_todos",
  {
    title: "待辦事項",
    description: "列出 TronClass 待辦事項（未完成的作業、測驗等），含課程與截止時間（UTC）。",
    annotations: { readOnlyHint: true },
  },
  () => runTool("list_todos", {}, () => tron.todos())
);

server.registerTool(
  "list_courses",
  {
    title: "我的課程",
    description: "列出我在 TronClass 上的課程，含課程 ID、學年、學期與授課教師。",
    inputSchema: {
      status: z
        .enum(["ongoing", "notStarted", "closed", "all"])
        .optional()
        .describe("ongoing（預設，進行中）、notStarted（未開始）、closed（已結束）或 all"),
    },
    annotations: { readOnlyHint: true },
  },
  ({ status = "ongoing" }) =>
    runTool("list_courses", { status }, async () =>
      ((await tron.myCourses(status === "all" ? {} : { status: [status] })) ?? []).map(
        (c) => ({
          id: c.id,
          name: c.name,
          course_code: c.course_code,
          credit: c.credit,
          academic_year: c.academic_year?.name,
          semester: c.semester?.name,
          instructors: (c.instructors ?? []).map((i) => i.name),
          start_date: c.start_date,
          end_date: c.end_date,
        })
      )
    )
);

server.registerTool(
  "list_semesters",
  {
    title: "我的學期",
    description: "列出我有課程的學期。",
    annotations: { readOnlyHint: true },
  },
  () =>
    runTool("list_semesters", {}, async () =>
      ((await tron.mySemesters()) ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        is_active: s.is_active,
      }))
    )
);

server.registerTool(
  "list_recent_courses",
  {
    title: "最近瀏覽的課程",
    description: "列出最近瀏覽過的 TronClass 課程。",
    annotations: { readOnlyHint: true },
  },
  () => runTool("list_recent_courses", {}, () => tron.recentlyVisitedCourses())
);

server.registerTool(
  "get_course_modules",
  {
    title: "課程章節",
    description: "列出某門課的週次／章節。",
    inputSchema: { course_id: courseId },
    annotations: { readOnlyHint: true },
  },
  ({ course_id }) =>
    runTool("get_course_modules", { course_id }, async () =>
      ((await tron.getCourseModules(course_id)) ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        sort: m.sort,
      }))
    )
);

server.registerTool(
  "get_my_groups",
  {
    title: "我的分組",
    description:
      "列出某門課的分組（例如期末專案分組）以及我所在的組別與組員（姓名、學號、是否為組長）。",
    inputSchema: { course_id: courseId },
    annotations: { readOnlyHint: true },
  },
  ({ course_id }) =>
    runTool("get_my_groups", { course_id }, async () => {
      const me = await getUserId();
      const sets = (await tron.getCourseGroupSets(course_id)) ?? [];
      return Promise.all(
        sets.map(async (s) => {
          const group = await myGroupIn(s.id);
          return {
            group_set_id: s.id,
            group_set_name: s.name,
            group_count: s.group_count,
            my_group: group ? groupInfo(group, me) : null,
          };
        })
      );
    })
);

server.registerTool(
  "list_announcements",
  {
    title: "課程公告",
    description:
      "列出課程公告（內容已轉成純文字）。不指定 course_id 時為我所有課程的公告。附件可用 reference_id 呼叫 download_material 下載。",
    inputSchema: {
      course_id: courseId.optional(),
      keyword: z.string().optional().describe("關鍵字"),
      start_date: date.describe("起始日期 YYYY-MM-DD"),
      end_date: date.describe("結束日期 YYYY-MM-DD"),
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("頁數，每頁 20 筆，預設 1；指定 course_id 時不分頁"),
    },
    annotations: { readOnlyHint: true },
  },
  (args) =>
    runTool("list_announcements", args, async () => {
      const { course_id, keyword, start_date: startDate, end_date: endDate, page } = args;
      const filters = { keyword, startDate, endDate };
      const bulletins = course_id
        ? await tron.getCourseBulletins(course_id, filters)
        : await tron.courseBulletins({ ...filters, page });
      return (bulletins ?? []).map(bulletin);
    })
);

server.registerTool(
  "list_school_announcements",
  {
    title: "全校公告",
    description: "列出 TronClass 全校公告（內容已轉成純文字）。",
    inputSchema: {
      page: z.number().int().min(1).optional().describe("頁數，每頁 20 筆，預設 1"),
    },
    annotations: { readOnlyHint: true },
  },
  ({ page }) =>
    runTool("list_school_announcements", page ? { page } : {}, async () =>
      ((await tron.orgBulletins(page)) ?? []).map(bulletin)
    )
);

server.registerTool(
  "list_notifications",
  {
    title: "通知",
    description: "列出 TronClass 通知與未讀數量，時間戳記為毫秒。",
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe("筆數，預設 20"),
      types: z
        .array(z.string())
        .optional()
        .describe(
          "只列出這些類型，例如 bulletin_created、homework_opened_for_submission、homework_expiring、homework_ended、homework_submitted、exam_opened、exam_score_updated、topic_create、topic_replies"
        ),
    },
    annotations: { readOnlyHint: true },
  },
  (args) =>
    runTool("list_notifications", args, async () => {
      const res = await tron.notifications(await getUserId(), args);
      return {
        unread_count: res.unread_count,
        items: (res.notifications ?? []).map((n) => ({
          id: n.id,
          type: n.type,
          unread: n.unread,
          timestamp: n.timestamp,
          ...pick(n.payload, [
            "course_name",
            "activity_title",
            "bulletin_title",
            "topic_title",
            "end_time",
          ]),
        })),
      };
    })
);

server.registerTool(
  "list_homework",
  {
    title: "課程作業",
    description:
      "列出某門課的作業，含開始／截止時間（UTC）、是否已繳交與分數。詳細說明與繳交紀錄用 get_homework。",
    inputSchema: { course_id: courseId },
    annotations: { readOnlyHint: true },
  },
  ({ course_id }) =>
    runTool("list_homework", { course_id }, async () =>
      (await tron.getHomeworkActivitiesByCourseId(course_id)).map((h) => ({
        id: h.id,
        title: h.title,
        start_time: h.start_time,
        end_time: h.end_time,
        is_in_progress: h.is_in_progress,
        is_closed: h.is_closed,
        submitted: h.submitted,
        submitted_status: h.submitted_status,
        user_submit_count: h.user_submit_count,
        submit_times: h.submit_times,
        score: h.score,
        score_published: h.score_published,
        attachments: (h.uploads ?? []).map((u) => ({
          reference_id: u.reference_id,
          name: u.name,
        })),
      }))
    )
);

server.registerTool(
  "get_homework",
  {
    title: "作業詳情",
    description:
      "作業的說明、時間（UTC）、繳交次數與能否撤回、老師附件，以及我的歷次繳交與草稿（含分數、評語、檔案）。分組作業會附上我的組別，繳交紀錄為全組的。",
    inputSchema: { activity_id: activityId },
    annotations: { readOnlyHint: true },
  },
  ({ activity_id }) =>
    runTool("get_homework", { activity_id }, async () => {
      const a = await tron.getActivity(activity_id);
      const group =
        a.submit_by_group && a.group_set_id
          ? await myGroupIn(a.group_set_id)
          : undefined;
      const submissions = group
        ? ((await tron.getGroupSubmissionList(activity_id, group.id)) ?? [])
        : await submissionsOf(activity_id);
      return {
        group: group ? groupInfo(group, await getUserId()) : undefined,
        id: a.id,
        title: a.title,
        description: htmlToText(a.data?.description),
        start_time: a.start_time,
        end_time: a.end_time,
        is_in_progress: a.is_in_progress,
        is_closed: a.is_closed,
        submit_times: a.data?.submit_times,
        allow_retract: a.data?.allow_retract,
        mode: a.data?.mode,
        multiple_choice_titles: choiceTitles(a),
        submit_by_group: a.submit_by_group,
        attachments: attachments(a.uploads),
        submissions: submissions.map(submission),
      };
    })
);

server.registerTool(
  "list_exams",
  {
    title: "課程考試",
    description: "列出某門課的線上考試與時間（UTC）。",
    inputSchema: { course_id: courseId },
    annotations: { readOnlyHint: true },
  },
  ({ course_id }) =>
    runTool("list_exams", { course_id }, async () =>
      (await tron.getExamList(course_id)).map((e) => ({
        id: e.id,
        title: e.title,
        start_time: e.start_time,
        end_time: e.end_time,
        ...pick(e, [
          "is_started",
          "is_in_progress",
          "is_closed",
          "submit_times",
          "submitted_times",
          "limit_time",
        ]),
      }))
    )
);

server.registerTool(
  "get_scores",
  {
    title: "課程成績",
    description: "某門課的考試成績與作業分數（score_published 為 false 表示尚未公布）。",
    inputSchema: { course_id: courseId },
    annotations: { readOnlyHint: true },
  },
  ({ course_id }) =>
    runTool("get_scores", { course_id }, async () => ({
      exam_scores: (await tron.getExamScores(course_id)) ?? [],
      homework: (await tron.getHomeworkActivitiesByCourseId(course_id)).map((h) => ({
        id: h.id,
        title: h.title,
        score: h.score,
        score_published: h.score_published,
      })),
    }))
);

server.registerTool(
  "list_forum_topics",
  {
    title: "討論區主題",
    description: "列出某門課各討論區的主題（每個討論區最多 50 筆）。用主題 id 呼叫 get_topic 看內容與回覆。",
    inputSchema: { course_id: courseId },
    annotations: { readOnlyHint: true },
  },
  ({ course_id }) =>
    runTool("list_forum_topics", { course_id }, async () => {
      const result = [];
      for (const c of (await tron.getTopicCategories(course_id)) ?? []) {
        const topics = await tron.getForumTopics(c.id);
        result.push({
          category_id: c.id,
          activity_id: c.activity_id,
          topics: topics.map((t) => ({
            id: t.id,
            title: t.title,
            created_at: t.created_at,
            author: t.created_by?.name,
          })),
        });
      }
      return result;
    })
);

server.registerTool(
  "get_topic",
  {
    title: "討論區主題內容",
    description: "討論區主題的內容與回覆（已轉成純文字）。",
    inputSchema: {
      topic_id: z.number().int().describe("主題 ID，可從 list_forum_topics 取得"),
    },
    annotations: { readOnlyHint: true },
  },
  ({ topic_id }) =>
    runTool("get_topic", { topic_id }, async () => {
      const t = await tron.getTopic(topic_id);
      // 回覆的欄位沒有實測過，有什麼就取什麼
      const replies = Array.isArray(t.replies) ? (t.replies as Record<string, any>[]) : [];
      return {
        id: t.id,
        title: t.title,
        created_at: t.created_at,
        author: t.created_by?.name,
        content: htmlToText(t.content),
        attachments: attachments(t.uploads as Upload[] | undefined),
        replies: replies.map((r) => ({
          id: r.id,
          created_at: r.created_at,
          author: r.created_by?.name ?? r.user?.name,
          content: htmlToText(r.content),
        })),
      };
    })
);

server.registerTool(
  "list_materials",
  {
    title: "課程教材",
    description:
      "列出某門課的學習活動（教材、作業、影片、連結等）與附件。要下載附件時，用附件的 reference_id 呼叫 download_material。",
    inputSchema: { course_id: courseId },
    annotations: { readOnlyHint: true },
  },
  ({ course_id }) =>
    runTool("list_materials", { course_id }, async () =>
      (await tron.getCourseActivities(course_id)).map((a) => ({
        id: a.id,
        title: a.title,
        type: a.type,
        start_time: a.start_time,
        end_time: a.end_time,
        uploads: (a.uploads ?? []).map((u) => ({
          reference_id: u.reference_id,
          name: u.name,
          size: u.size,
          allow_download: u.allow_download,
        })),
      }))
    )
);

server.registerTool(
  "download_material",
  {
    title: "下載教材附件",
    description: `把附件下載到本機的 ${downloadDir}，回傳檔案路徑。reference_id 來自 list_materials、list_announcements 或 get_homework。`,
    inputSchema: {
      reference_id: z
        .number()
        .int()
        .describe("附件的 reference_id，可從 list_materials 取得"),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  ({ reference_id }) =>
    runTool("download_material", { reference_id }, async () => {
      const file = await tron.downloadUpload(reference_id);
      // 只取檔名部分，避免伺服器給的檔名跳出下載目錄
      const name = basename((file.filename ?? "").replace(/\\/g, "/"));
      const path = join(
        downloadDir,
        ["", ".", ".."].includes(name) ? `upload-${reference_id}` : name
      );
      await mkdir(downloadDir, { recursive: true });
      await writeFile(path, file.data);
      return { path, size: file.data.length, content_type: file.contentType };
    })
);

server.registerTool(
  "save_homework_draft",
  {
    title: "儲存作業草稿",
    description:
      "上傳本機檔案並存成作業草稿（會覆蓋現有的草稿），只存草稿、不會繳交。要正式繳交請在使用者確認後呼叫 submit_homework。不支援分組作業。",
    inputSchema: {
      activity_id: activityId,
      file_paths: z
        .array(z.string())
        .describe(
          "要上傳的本機檔案絕對路徑（不能是隱藏檔、隱藏目錄或系統目錄中的檔案，單檔上限 100 MB）；py、java、cpp 等不在學校白名單的檔案建議先壓成 zip"
        ),
      comment: z.string().optional().describe("作業內文，可為純文字或 HTML"),
      multiple_choice_title: multipleChoiceTitle,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  async (args) => {
    const { activity_id, file_paths, comment, multiple_choice_title } = args;
    if (!file_paths.length && !comment) return text("至少要有一個檔案或 comment。", true);
    // 先讀檔，檔案有問題時不必登入或上傳
    let files: Awaited<ReturnType<typeof readLocalFile>>[];
    try {
      files = await Promise.all(file_paths.map(readLocalFile));
    } catch (e) {
      return errorText(e);
    }
    return runTool("save_homework_draft", args, async () => {
      const activity = await tron.getActivity(activity_id);
      rejectGroupHomework(activity);
      const mode = activity.data?.mode;
      if (mode === "multiple" && !multiple_choice_title) {
        throw new Error(
          `這份作業需要指定 multiple_choice_title，可選：${choiceTitles(activity)?.join("、")}`
        );
      }
      const draft = (await submissionsOf(activity_id)).find((s) => s.is_draft);
      const uploads: CreatedUpload[] = [];
      try {
        for (const f of files) uploads.push(await tron.uploadFile(f.name, f.data, f.type));
        const res = await tron.saveSubmission(activity_id, {
          uploadIds: uploads.map((u) => u.id),
          comment,
          isDraft: true,
          submissionId: draft?.id,
          mode,
          multipleChoiceTitle: multiple_choice_title,
        });
        return {
          draft_id: res.submission?.id ?? draft?.id,
          replaced_draft: draft !== undefined,
          files: uploads.map((u) => u.name),
        };
      } catch (e) {
        // 這次上傳但沒存進草稿的檔案會留在「我的資源」，盡量刪掉；
        // 在 op 的 context 外執行，這次呼叫被取消（等驗證碼）時也會在登入後刪除
        await auth.detached(() =>
          Promise.all(uploads.map((u) => tron.deleteUpload(u.id).catch(() => {})))
        );
        throw e;
      }
    });
  }
);

server.registerTool(
  "submit_homework",
  {
    title: "繳交作業",
    description:
      "正式繳交作業；呼叫前必須先向使用者確認。會把 save_homework_draft 存的草稿轉成正式繳交，繳交後只有作業允許撤回時才能用 retract_submission 撤回。",
    inputSchema: {
      activity_id: activityId,
      multiple_choice_title: multipleChoiceTitle.describe(
        "作業 mode 為 multiple 且草稿沒有記錄所選題目時才需要"
      ),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  (args) =>
    runTool("submit_homework", args, async () => {
      const { activity_id } = args;
      const activity = await tron.getActivity(activity_id);
      rejectGroupHomework(activity);
      const draft = (await submissionsOf(activity_id)).find((s) => s.is_draft);
      if (!draft) {
        throw new Error(
          "找不到草稿，請先呼叫 save_homework_draft。若剛才已經繳交過，請先用 get_homework 確認繳交紀錄。"
        );
      }
      const mode = activity.data?.mode ?? str(draft.mode);
      const draftTitle = str(draft.multiple_choice_title);
      if (draftTitle && args.multiple_choice_title && draftTitle !== args.multiple_choice_title) {
        throw new Error(
          `草稿選的題目是「${draftTitle}」，與 multiple_choice_title「${args.multiple_choice_title}」不同。要換題目請重新呼叫 save_homework_draft。`
        );
      }
      const title = draftTitle ?? args.multiple_choice_title;
      if (mode === "multiple" && !title) {
        throw new Error(
          `這份作業需要 multiple_choice_title，可選：${choiceTitles(activity)?.join("、")}`
        );
      }
      const res = await tron.saveSubmission(activity_id, {
        uploadIds: (draft.uploads ?? []).map((u) => u.id),
        comment: draft.comment,
        isDraft: false,
        submissionId: draft.id,
        mode,
        multipleChoiceTitle: title,
      });
      // 直接用繳交的回應，不再讀一次列表：之後的請求出問題不會讓已完成的繳交被回報成失敗
      return {
        submitted: true,
        submission_id: res.submission?.id ?? draft.id,
        submitted_at: res.submission?.submitted_at,
        files: (draft.uploads ?? []).map((u) => u.name),
        message: res.message,
      };
    })
);

server.registerTool(
  "retract_submission",
  {
    title: "撤回繳交",
    description:
      "撤回已正式繳交的作業，撤回後會變回草稿。只有允許撤回時才能用（get_homework 的 allow_retract 與該筆繳交的 can_retract）；呼叫前先向使用者確認。",
    inputSchema: {
      submission_id: z.number().int().describe("繳交紀錄的 id，可從 get_homework 的 submissions 取得"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  ({ submission_id }) =>
    runTool("retract_submission", { submission_id }, async () => {
      await tron.retractSubmission(submission_id);
      return { retracted: true, submission_id };
    })
);

await server.connect(new StdioServerTransport());
