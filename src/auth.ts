import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import TronClass, { type loginResponse } from "tronclass-api";

// 驗證碼連續錯幾次後停止自動換新驗證碼
export const MAX_CAPTCHA_FAILURES = 5;
// 驗證碼放太久，CAS 端的登入表單可能已失效（實際時限未知）
const CAPTCHA_TTL_MS = 5 * 60_000;
// 等待 CAS 回應的上限；lib 的 fetch 沒有逾時設定
const AUTH_WAIT_MS = 60_000;

export type AuthEvent =
  | { type: "captcha"; image: string; expired?: boolean } // base64 JPEG；expired 表示上一張已過期
  | { type: "login"; result: loginResponse }
  | { type: "timeout" };

export type RunResult<T> =
  | { type: "ok"; value: T }
  | { type: "captcha"; image: string }
  | { type: "timeout" }
  | { type: "login-failed"; result: loginResponse };

/** 停止自動登入的原因；呼叫 login tool（resetFailures）前不會再自動登入 */
export type LoginStop =
  | { reason: "captcha" } // 驗證碼連續錯太多次
  | { reason: "credentials"; message: string }; // 帳密錯誤，不自動重試以免帳號被鎖

// 執行中的 tool 呼叫：回傳驗證碼後 signal 會取消這次呼叫的所有請求（包含 lib 重新登入後重送的請求）；
// onReauth 表示這次呼叫觸發（或加入）了重新登入
type OpContext = { signal: AbortSignal; onReauth: () => void };
const opContext = new AsyncLocalStorage<OpContext>();

// 同一時間只跑一個登入（包含 lib 在 session 過期時自動觸發的），並回報每次登入的結果
class ObservedTronClass extends TronClass {
  private current?: Promise<loginResponse>;
  onLogin?: (result: loginResponse) => void;
  /** 回傳 true 時不自動登入（帳密錯誤或驗證碼連續錯誤後），連背景的請求也不例外 */
  blocked?: () => boolean;

  get inFlight() {
    return this.current !== undefined;
  }

  // lib 偵測到 session 過期時會重新登入再重送同一個請求；這次呼叫已被取消時，重送的請求也要取消
  override async call(endpoint: string, config: RequestInit = {}) {
    const ctx = opContext.getStore();
    ctx?.signal.throwIfAborted();
    return super.call(endpoint, { ...config, signal: config.signal ?? ctx?.signal });
  }

  override login(...args: Parameters<TronClass["login"]>) {
    if (!this.current && this.blocked?.()) {
      return Promise.resolve({ success: false, message: "已停止自動登入，請呼叫 login。" });
    }
    opContext.getStore()?.onReauth();
    this.current ??= (async () => {
      let result: loginResponse;
      try {
        result = await super.login(...args);
      } catch (e) {
        result = { success: false, message: e instanceof Error ? e.message : String(e) };
      } finally {
        this.current = undefined;
      }
      // 先清掉 current 再通知，收到通知的一方才能立刻開始下一次登入
      this.onLogin?.(result);
      return result;
    })();
    return this.current;
  }
}

/**
 * 把 lib 的 OCR callback 接到 MCP tool 呼叫上：
 * lib 要驗證碼時發出 captcha 事件並等待 submit()，由 client 端的 agent 看圖回答。
 */
export class Auth {
  readonly tron = new ObservedTronClass();
  private events = new EventEmitter();
  private pending?: { image: string; at: number; resolve: (code: string) => void };
  private loggedIn = false;
  private captchaFailures = 0;
  private credentialsError?: string;
  private ignoreNextResult = false;

  constructor(
    private username: string,
    private password: string,
    baseUrl: string
  ) {
    this.tron.setBaseUrl(baseUrl);
    this.tron.blocked = () => this.stopped !== undefined;
    this.tron.onLogin = (result) => {
      this.loggedIn = result.success;
      // 驗證碼錯誤次數在 submit() 計算；只有帳密錯誤會擋住之後的自動登入
      if (this.ignoreNextResult) this.ignoreNextResult = false;
      else if (result.success) this.resetFailures();
      else if (result.reason === "credentials") this.credentialsError = result.message;
      this.events.emit("login", result);
    };
  }

  private ocr = (dataUrl: string) =>
    new Promise<string>((resolve) => {
      this.pending = { image: dataUrl.split(",")[1], at: Date.now(), resolve };
      this.events.emit("captcha", this.pending.image);
    });

  private waitFor(names: ("captcha" | "login")[], timeoutMs?: number) {
    let cancel = () => {};
    const promise = new Promise<AuthEvent>((resolve) => {
      const done = (event: AuthEvent) => {
        cancel();
        resolve(event);
      };
      const handlers = {
        captcha: (image: string) => done({ type: "captcha", image }),
        login: (result: loginResponse) => done({ type: "login", result }),
      };
      const timer = timeoutMs
        ? setTimeout(() => done({ type: "timeout" }), timeoutMs)
        : undefined;
      cancel = () => {
        clearTimeout(timer);
        names.forEach((n) => this.events.off(n, handlers[n]));
      };
      names.forEach((n) => this.events.on(n, handlers[n]));
    });
    return { promise, cancel: () => cancel() };
  }

  /** 已登入，且沒有進行中的登入或等待中的驗證碼 */
  get ready() {
    return this.loggedIn && !this.tron.inFlight && !this.pending;
  }

  /** 已停止自動登入時回傳原因 */
  get stopped(): LoginStop | undefined {
    if (this.credentialsError !== undefined) {
      return { reason: "credentials", message: this.credentialsError };
    }
    if (this.captchaFailures >= MAX_CAPTCHA_FAILURES) return { reason: "captcha" };
  }

  resetFailures() {
    this.captchaFailures = 0;
    this.credentialsError = undefined;
  }

  /** 在 tool 呼叫的 context 外執行，例如清理：不受已取消的 signal 影響，也不會被當成這次呼叫的重新登入 */
  detached<T>(fn: () => T): T {
    return opContext.exit(fn);
  }

  private get pendingExpired() {
    return !!this.pending && Date.now() - this.pending.at > CAPTCHA_TTL_MS;
  }

  // 放棄過期的驗證碼：送出空字串讓 lib 直接判定失敗（不會送出表單），且不計入失敗次數
  private async discardPending() {
    const pending = this.pending!;
    this.pending = undefined;
    const done = this.waitFor(["login"], AUTH_WAIT_MS);
    this.ignoreNextResult = true;
    pending.resolve("");
    await done.promise;
  }

  /** 開始登入（或加入進行中的登入）並等到需要驗證碼；若已有等待中的驗證碼就直接回傳 */
  async begin(): Promise<AuthEvent> {
    if (this.pendingExpired) await this.discardPending();
    if (this.pending) return { type: "captcha", image: this.pending.image };

    const next = this.waitFor(["captcha", "login"], AUTH_WAIT_MS);
    if (!this.tron.inFlight) {
      // 結果由 onLogin 透過 login 事件回報
      this.tron.login(this.username, this.password, this.ocr);
    }
    return next.promise;
  }

  /**
   * 送出驗證碼，等到登入結束或 lib 要下一張驗證碼。
   * 驗證碼錯誤時 lib 會自己換一張重試（第 3 次才回傳 reason "captcha"），
   * 所以收到新的驗證碼也代表剛才的驗證碼錯了。連續錯太多次時放棄等待中的驗證碼，由 stopped 回報。
   */
  async submit(code: string): Promise<AuthEvent> {
    const pending = this.pending;
    if (!pending) throw new Error("目前沒有等待中的驗證碼，請先呼叫 login。");
    // 驗證碼放太久就不送出，換一張新的（begin 會丟掉過期的那張）
    if (this.pendingExpired) {
      const event = await this.begin();
      return event.type === "captcha" ? { ...event, expired: true } : event;
    }
    this.pending = undefined;
    const next = this.waitFor(["captcha", "login"], AUTH_WAIT_MS);
    pending.resolve(code);
    const event = await next.promise;
    const wrong =
      event.type === "captcha" ||
      (event.type === "login" && event.result.reason === "captcha");
    if (wrong && ++this.captchaFailures >= MAX_CAPTCHA_FAILURES && this.pending) {
      await this.discardPending();
    }
    return event;
  }

  /**
   * 執行 API 呼叫；未登入時先回傳驗證碼。
   * 只有這次呼叫自己需要重新登入（session 過期）時才中途回傳驗證碼，並取消這次呼叫剩下與重送的請求；
   * 其他 tool 觸發的登入不會打斷這次呼叫。
   */
  async run<T>(op: () => Promise<T>): Promise<RunResult<T>> {
    if (!this.ready) {
      if (this.stopped) {
        return { type: "login-failed", result: { success: false, message: "已停止自動登入" } };
      }
      const event = await this.begin();
      if (event.type !== "login") return event;
      if (!event.result.success) return { type: "login-failed", result: event.result };
    }

    const abort = new AbortController();
    let reauthed = () => {};
    const work = opContext.run({ signal: abort.signal, onReauth: () => reauthed() }, op);
    const done = work.then((value) => ({ type: "ok" as const, value }));
    for (;;) {
      const reauth = new Promise<{ type: "reauth" }>(
        (resolve) => (reauthed = () => resolve({ type: "reauth" }))
      );
      const first = await Promise.race([done, reauth]);
      if (first.type === "ok") return first;

      // 這次呼叫觸發（或加入）了重新登入：需要驗證碼就先回傳；登入成功就讓 op 繼續，失敗時 op 會自己拋錯
      const wait = this.waitFor(["captcha", "login"], AUTH_WAIT_MS);
      try {
        const event = this.pending
          ? { type: "captcha" as const, image: this.pending.image }
          : await Promise.race([wait.promise, done]);
        if (event.type === "ok") return event;
        if (event.type === "captcha" || event.type === "timeout") {
          abort.abort();
          work.catch(() => {});
          return event.type === "captcha" ? { type: "captcha", image: event.image } : event;
        }
      } finally {
        wait.cancel();
      }
    }
  }
}
