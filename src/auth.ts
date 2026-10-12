import { EventEmitter } from "node:events";
import TronClass, { type loginResponse } from "tronclass-api";

// 連續登入失敗幾次後停止自動登入（lib 分不出驗證碼錯還是帳密錯，避免帳密錯時一直嘗試）
const MAX_LOGIN_FAILURES = 3;
// 驗證碼放太久，CAS 端的登入表單可能已失效（實際時限未知）
const CAPTCHA_TTL_MS = 5 * 60_000;
// 等待 CAS 回應的上限；lib 的 fetch 沒有逾時設定
const AUTH_WAIT_MS = 60_000;

export type AuthEvent =
  | { type: "captcha"; image: string } // base64 JPEG
  | { type: "login"; result: loginResponse }
  | { type: "timeout" };

export type RunResult<T> =
  | { type: "ok"; value: T }
  | { type: "captcha"; image: string }
  | { type: "timeout" }
  | { type: "login-failed"; message: string };

// 同一時間只跑一個登入（包含 lib 在 session 過期時自動觸發的），並回報每次登入的結果
class ObservedTronClass extends TronClass {
  private current?: Promise<loginResponse>;
  onLogin?: (result: loginResponse) => void;

  get inFlight() {
    return this.current !== undefined;
  }

  override login(...args: Parameters<TronClass["login"]>) {
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
  private failures = 0;
  private ignoreNextResult = false;

  constructor(
    private username: string,
    private password: string,
    baseUrl: string
  ) {
    this.tron.setBaseUrl(baseUrl);
    this.tron.onLogin = (result) => {
      this.loggedIn = result.success;
      if (this.ignoreNextResult) this.ignoreNextResult = false;
      else this.failures = result.success ? 0 : this.failures + 1;
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

  get tooManyFailures() {
    return this.failures >= MAX_LOGIN_FAILURES;
  }

  resetFailures() {
    this.failures = 0;
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
    if (this.pending && Date.now() - this.pending.at > CAPTCHA_TTL_MS) {
      await this.discardPending();
    }
    if (this.pending) return { type: "captcha", image: this.pending.image };

    const next = this.waitFor(["captcha", "login"], AUTH_WAIT_MS);
    if (!this.tron.inFlight) {
      // 結果由 onLogin 透過 login 事件回報
      this.tron.login(this.username, this.password, this.ocr);
    }
    return next.promise;
  }

  /** 送出驗證碼，等到登入結束或 lib 要下一張驗證碼 */
  async submit(code: string): Promise<AuthEvent> {
    const pending = this.pending;
    if (!pending) throw new Error("目前沒有等待中的驗證碼，請先呼叫 login。");
    this.pending = undefined;
    const next = this.waitFor(["captcha", "login"], AUTH_WAIT_MS);
    pending.resolve(code);
    return next.promise;
  }

  /** 執行 API 呼叫；未登入或途中 session 過期需要驗證碼時，先回傳驗證碼 */
  async run<T>(op: () => Promise<T>): Promise<RunResult<T>> {
    if (!this.ready) {
      if (this.tooManyFailures) {
        return { type: "login-failed", message: "已停止自動登入" };
      }
      const event = await this.begin();
      if (event.type !== "login") return event;
      if (!event.result.success) {
        return { type: "login-failed", message: event.result.message };
      }
    }

    // 其他 tool 觸發的重新登入也會讓這裡收到驗證碼，此時這次呼叫需要重來
    const captcha = this.waitFor(["captcha"]);
    const work = op();
    try {
      const first = await Promise.race([
        work.then((value) => ({ type: "ok" as const, value })),
        captcha.promise as Promise<{ type: "captcha"; image: string }>,
      ]);
      // 等驗證碼時 op 仍在背景等 lib 重新登入，結果不再需要
      if (first.type === "captcha") work.catch(() => {});
      return first;
    } finally {
      captcha.cancel();
    }
  }
}
