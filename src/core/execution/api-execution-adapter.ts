import type {
  AdapterStatus,
  ExecutionAdapter,
  ExecutionRequest,
  ExecutionResult,
} from "./types";

interface ApiExecutionInput {
  method?: unknown;
  url?: unknown;
  headers?: unknown;
  body?: unknown;
  timeoutMs?: unknown;
  allowedHosts?: unknown;
}

interface ApiExecutionOutput {
  mode: "SAFE_API_EXECUTION";
  method: string;
  url: string;
  statusCode?: number;
  responseHeaders?: Record<string, string>;
  responseText?: string;
  success: boolean;
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

function extractInput(
  input: unknown,
): {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  allowedHosts: string[];
} | null {
  if (
    typeof input !== "object" ||
    input === null
  ) {
    return null;
  }

  const value =
    input as ApiExecutionInput;

  const method =
    typeof value.method === "string"
      ? value.method.toUpperCase()
      : "GET";

  const url =
    typeof value.url === "string"
      ? value.url.trim()
      : "";

  const headers: Record<string, string> = {};

  if (
    typeof value.headers === "object" &&
    value.headers !== null
  ) {
    for (const [key, raw] of Object.entries(
      value.headers as Record<string, unknown>,
    )) {
      if (typeof raw === "string") {
        headers[key] = raw;
      }
    }
  }

  const body =
    typeof value.body === "string"
      ? value.body
      : value.body === undefined
        ? undefined
        : JSON.stringify(value.body);

  const timeoutMs =
    typeof value.timeoutMs === "number" &&
    Number.isFinite(value.timeoutMs) &&
    value.timeoutMs > 0
      ? Math.min(value.timeoutMs, 30000)
      : 15000;

  const allowedHosts =
    Array.isArray(value.allowedHosts)
      ? value.allowedHosts.filter(
          (host): host is string =>
            typeof host === "string" &&
            host.trim().length > 0,
        )
      : [];

  return {
    method,
    url,
    headers,
    body,
    timeoutMs,
    allowedHosts,
  };
}

export class ApiExecutionAdapter
  implements ExecutionAdapter
{
  public readonly capability = "API" as const;

  status(): AdapterStatus {
    return "AVAILABLE";
  }

  canExecute(
    request: ExecutionRequest,
  ): boolean {
    return (
      request.capability === "API" &&
      [
        "REQUEST",
        "CALL",
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
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
          "API execution requires explicit approval.",
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
          `API capability does not support action ${request.action}.`,
      };
    }

    const input =
      extractInput(request.input);

    if (!input) {
      return {
        ...baseResult(
          request,
          "BLOCKED",
          startedAt,
        ),
        error:
          "Invalid API execution input.",
      };
    }

    let parsed: URL;

    try {
      parsed = new URL(input.url);
    } catch {
      return {
        ...baseResult(
          request,
          "BLOCKED",
          startedAt,
        ),
        error:
          "API URL must be valid.",
      };
    }

    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:"
    ) {
      return {
        ...baseResult(
          request,
          "BLOCKED",
          startedAt,
        ),
        error:
          "Only HTTP and HTTPS API requests are allowed.",
      };
    }

    if (
      input.allowedHosts.length === 0
    ) {
      return {
        ...baseResult(
          request,
          "BLOCKED",
          startedAt,
        ),
        error:
          "API execution requires an explicit host allowlist.",
      };
    }

    if (
      !input.allowedHosts.includes(
        parsed.hostname,
      )
    ) {
      return {
        ...baseResult(
          request,
          "BLOCKED",
          startedAt,
        ),
        error:
          `API host is not allowlisted: ${parsed.hostname}`,
      };
    }

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => controller.abort(),
        input.timeoutMs,
      );

    try {
      const response =
        await fetch(
          parsed.toString(),
          {
            method:
              input.method,
            headers:
              input.headers,
            body:
              input.method === "GET" ||
              input.method === "HEAD"
                ? undefined
                : input.body,
            signal:
              controller.signal,
          },
        );

      const responseText =
        await response.text();

      const responseHeaders:
        Record<string, string> = {};

      response.headers.forEach(
        (value, key) => {
          responseHeaders[key] = value;
        },
      );

      const output:
        ApiExecutionOutput = {
        mode:
          "SAFE_API_EXECUTION",
        method:
          input.method,
        url:
          parsed.toString(),
        statusCode:
          response.status,
        responseHeaders,
        responseText,
        success:
          response.ok,
        shellExecuted:
          false,
      };

      return {
        ...baseResult(
          request,
          response.ok
            ? "COMPLETED"
            : "FAILED",
          startedAt,
        ),
        output,
        ...(response.ok
          ? {}
          : {
              error:
                `API request returned HTTP ${response.status}.`,
            }),
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
      clearTimeout(timeout);
    }
  }
}
