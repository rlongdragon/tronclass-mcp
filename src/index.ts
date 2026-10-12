#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { RateLimitError } from "tronclass-api";
import { z } from "zod";
import { Auth, type AuthEvent, type RunResult } from "./auth.js";

const username = process.env.TRON_USER;
const password = process.env.TRON_PASS;
const baseUrl = process.env.TRON_BASE_URL ?? "https://tronclass.ntou.edu.tw";
const downloadDir =
  process.env.TRON_DOWNLOAD_DIR ?? join(homedir(), "Downloads", "tronclass");

if (!username || !password) {
  console.error("請在 MCP server 的 env 設定 TRON_USER 與 TRON_PASS。");
  process.exit(1);
}

const auth = new Auth(username, password, baseUrl);
const tron = auth.tron;

const text = (t: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text: t }],
  ...(isError && { isError: true }),
});

const captchaResult = (image: string, message: string): CallToolResult => ({
  content: [
    {
      type: "text",
      text: `${message}\n請辨識圖片中的 4 位數字驗證碼，然後呼叫 submit_captcha。`,
    },
    { type: "image", data: image, mimeType: "image/jpeg" },
  ],
});

// 登入失敗時自動換一張新的驗證碼，連續失敗太多次就停下來。
// lib 對驗證碼錯誤與帳密錯誤回傳同樣的訊息，因此兩者都提示。
async function loginFailed(message: string): Promise<CallToolResult> {
  if (auth.tooManyFailures) {
    return text(
      `登入連續失敗（驗證碼或帳密錯誤）：${message}\n請確認 TRON_USER / TRON_PASS 是否正確後再呼叫 login。`,
      true
    );
  }
  return authEventResult(await auth.begin(), `登入失敗（驗證碼或帳密錯誤）：${message}`);
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
    const retry = [...toolsToRetry];
    toolsToRetry.clear();
    return text(
      retry.length ? `登入成功。請重新呼叫：${retry.join("、")}` : "登入成功。"
    );
  }
  return loginFailed(event.result.message);
}

// 因需要登入而沒有完成的 tool 呼叫，登入成功後提示 agent 重新呼叫
const toolsToRetry = new Set<string>();

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
    return text(e instanceof Error ? e.message : String(e), true);
  }
  if (result.type !== "ok") {
    toolsToRetry.add(
      Object.keys(args).length ? `${name}(${JSON.stringify(args)})` : name
    );
  }
  if (result.type === "timeout") return timeoutResult();
  if (result.type === "captcha") return captchaResult(result.image, "需要登入 TronClass。");
  if (result.type === "login-failed") return loginFailed(result.message);
  // lib 在回應缺少預期的 key 時會回傳 undefined，而 JSON.stringify(undefined) 不是字串
  return text(JSON.stringify(result.value ?? null));
}

const server = new McpServer({ name: "tronclass-ntou", version: "0.1.0" });

server.registerTool(
  "login",
  {
    title: "登入 TronClass",
    description:
      "開始登入海大 TronClass，回傳 4 位數字驗證碼圖片。辨識後呼叫 submit_captcha。其他 tool 在需要登入時也會自動回傳驗證碼。",
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
      return await authEventResult(await auth.submit(code.trim()), "需要另一張驗證碼。");
    } catch (e) {
      return text(e instanceof Error ? e.message : String(e), true);
    }
  }
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
    description: "列出我在 TronClass 上的所有課程，含課程 ID。",
    annotations: { readOnlyHint: true },
  },
  () => runTool("list_courses", {}, () => tron.myCourses({}, undefined))
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
  "list_homework",
  {
    title: "課程作業",
    description: "列出某門課的作業，含開始／截止時間（UTC）與分數。",
    inputSchema: {
      course_id: z.number().int().describe("課程 ID，可從 list_courses 取得"),
    },
    annotations: { readOnlyHint: true },
  },
  ({ course_id }) =>
    runTool("list_homework", { course_id }, () =>
      tron.getHomeworkActivitiesByCourseId(course_id)
    )
);

server.registerTool(
  "list_materials",
  {
    title: "課程教材",
    description:
      "列出某門課的學習活動（教材、作業、影片、連結等）與附件。要下載附件時，用附件的 reference_id 呼叫 download_material。",
    inputSchema: {
      course_id: z.number().int().describe("課程 ID，可從 list_courses 取得"),
    },
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
    description: `把附件下載到本機的 ${downloadDir}，回傳檔案路徑。reference_id 來自 list_materials。`,
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

await server.connect(new StdioServerTransport());
