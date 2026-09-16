import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";

import type {
  AdapterStatus,
  ExecutionAdapter,
  ExecutionRequest,
  ExecutionResult,
} from "./types";

type BrowserAction =
  | "NAVIGATE"
  | "CLICK"
  | "FILL"
  | "EXTRACT"
  | "SCREENSHOT";

interface BrowserInput {
  action?: unknown;
  url?: unknown;
  selector?: unknown;
  value?: unknown;
  allowedHosts?: unknown;
  timeoutMs?: unknown;
  fullPage?: unknown;
}

interface BrowserOutput {
  mode: "SAFE_BROWSER_EXECUTION";
  action: BrowserAction;
  url?: string;
  title?: string;
  text?: string;
  screenshotPath?: string;
  shellExecuted: false;
}

function baseResult(
  request: ExecutionRequest,
  status: ExecutionResult["status"],
  startedAt: string,
): ExecutionResult {
  return {
    id: crypto.randomUUID(),
    requestId: request.id,
    capability: request.capability,
    status,
    evidenceIds: [],
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

function parseInput(
  input: unknown,
): {
  action: BrowserAction;
  url?: string;
  selector?: string;
  value?: string;
  allowedHosts: string[];
  timeoutMs: number;
  fullPage: boolean;
} | null {
  if (
    typeof input !== "object" ||
    input === null
  ) {
    return null;
  }

  const value = input as BrowserInput;

  const action =
    typeof value.action === "string" &&
    [
      "NAVIGATE",
      "CLICK",
      "FILL",
      "EXTRACT",
      "SCREENSHOT",
    ].includes(value.action)
      ? value.action as BrowserAction
      : null;

  if (!action) {
    return null;
  }

  const url =
    typeof value.url === "string"
      ? value.url.trim()
      : undefined;

  const selector =
    typeof value.selector === "string"
      ? value.selector
      : undefined;

  const parsedValue =
    typeof value.value === "string"
      ? value.value
      : undefined;

  const allowedHosts =
    Array.isArray(value.allowedHosts)
      ? value.allowedHosts.filter(
          (host): host is string =>
            typeof host === "string" &&
            host.trim().length > 0,
        )
      : [];

  const timeoutMs =
    typeof value.timeoutMs === "number" &&
    Number.isFinite(value.timeoutMs) &&
    value.timeoutMs > 0
      ? Math.min(value.timeoutMs, 30000)
      : 15000;

  return {
    action,
    url,
    selector,
    value: parsedValue,
    allowedHosts,
    timeoutMs,
    fullPage:
      value.fullPage === true,
  };
}

function validateUrl(
  url: string | undefined,
  allowedHosts: string[],
): {
  ok: boolean;
  parsed?: URL;
  error?: string;
} {
  if (!url) {
    return {
      ok: false,
      error: "Browser action requires a URL.",
    };
  }

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return {
      ok: false,
      error: "Browser URL must be valid.",
    };
  }

  if (
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:"
  ) {
    return {
      ok: false,
      error:
        "Only HTTP and HTTPS browser URLs are allowed.",
    };
  }

  if (allowedHosts.length === 0) {
    return {
      ok: false,
      error:
        "Browser execution requires an explicit host allowlist.",
    };
  }

  if (!allowedHosts.includes(parsed.hostname)) {
    return {
      ok: false,
      error:
        `Browser host is not allowlisted: ${parsed.hostname}`,
    };
  }

  return {
    ok: true,
    parsed,
  };
}

export class BrowserExecutionAdapter
  implements ExecutionAdapter
{
  public readonly capability =
    "BROWSER" as const;

  status(): AdapterStatus {
    return "AVAILABLE";
  }

  canExecute(
    request: ExecutionRequest,
  ): boolean {
    return (
      request.capability === "BROWSER" &&
      [
        "NAVIGATE",
        "CLICK",
        "FILL",
        "EXTRACT",
        "SCREENSHOT",
      ].includes(request.action)
    );
  }

  async execute(
    request: ExecutionRequest,
  ): Promise<ExecutionResult> {
    const startedAt =
      new Date().toISOString();

    if (
      request.requiresApproval &&
      !request.approved
    ) {
      return {
        ...baseResult(
          request,
          "WAITING_APPROVAL",
          startedAt,
        ),
        error:
          "Browser execution requires explicit approval.",
      };
    }

    if (!this.canExecute(request)) {
      return {
        ...baseResult(
          request,
          "BLOCKED",
          startedAt,
        ),
        error:
          `BROWSER capability does not support action ${request.action}.`,
      };
    }

    const input = parseInput(
      request.input,
    );

    if (!input) {
      return {
        ...baseResult(
          request,
          "BLOCKED",
          startedAt,
        ),
        error:
          "Invalid browser execution input.",
      };
    }

    const validation =
      validateUrl(
        input.url,
        input.allowedHosts,
      );

    if (!validation.ok) {
      return {
        ...baseResult(
          request,
          "BLOCKED",
          startedAt,
        ),
        error: validation.error,
      };
    }

    const parsedUrl =
      validation.parsed as URL;

    let browser:
      Browser | undefined;

    let context:
      BrowserContext | undefined;

    let page:
      Page | undefined;

    try {
      browser =
        await chromium.launch({
          headless: true,
        });

      context =
        await browser.newContext();

      page =
        await context.newPage();

      page.setDefaultTimeout(
        input.timeoutMs,
      );

      await page.goto(
        parsedUrl.toString(),
        {
          waitUntil:
            "domcontentloaded",
          timeout:
            input.timeoutMs,
        },
      );

      let output:
        BrowserOutput;

      switch (input.action) {
        case "NAVIGATE":
          output = {
            mode:
              "SAFE_BROWSER_EXECUTION",
            action:
              input.action,
            url:
              page.url(),
            title:
              await page.title(),
            shellExecuted:
              false,
          };
          break;

        case "CLICK":
          if (!input.selector) {
            return {
              ...baseResult(
                request,
                "BLOCKED",
                startedAt,
              ),
              error:
                "CLICK requires a selector.",
            };
          }

          await page.click(
            input.selector,
          );

          output = {
            mode:
              "SAFE_BROWSER_EXECUTION",
            action:
              input.action,
            url:
              page.url(),
            title:
              await page.title(),
            shellExecuted:
              false,
          };
          break;

        case "FILL":
          if (
            !input.selector ||
            input.value === undefined
          ) {
            return {
              ...baseResult(
                request,
                "BLOCKED",
                startedAt,
              ),
              error:
                "FILL requires selector and value.",
            };
          }

          await page.fill(
            input.selector,
            input.value,
          );

          output = {
            mode:
              "SAFE_BROWSER_EXECUTION",
            action:
              input.action,
            url:
              page.url(),
            title:
              await page.title(),
            shellExecuted:
              false,
          };
          break;

        case "EXTRACT":
          output = {
            mode:
              "SAFE_BROWSER_EXECUTION",
            action:
              input.action,
            url:
              page.url(),
            title:
              await page.title(),
            text:
              await page
                .locator("body")
                .innerText(),
            shellExecuted:
              false,
          };
          break;

        case "SCREENSHOT": {
          const screenshotPath =
            `browser-evidence-${crypto.randomUUID()}.png`;

          await page.screenshot({
            path:
              screenshotPath,
            fullPage:
              input.fullPage,
          });

          output = {
            mode:
              "SAFE_BROWSER_EXECUTION",
            action:
              input.action,
            url:
              page.url(),
            title:
              await page.title(),
            screenshotPath,
            shellExecuted:
              false,
          };

          break;
        }
      }

      return {
        ...baseResult(
          request,
          "COMPLETED",
          startedAt,
        ),
        output,
      };
    } catch (error) {
      return {
        ...baseResult(
          request,
          "FAILED",
          startedAt,
        ),
        error:
          error instanceof Error
            ? error.message
            : String(error),
      };
    } finally {
      await page
        ?.close()
        .catch(() => undefined);

      await context
        ?.close()
        .catch(() => undefined);

      await browser
        ?.close()
        .catch(() => undefined);
    }
  }
}
