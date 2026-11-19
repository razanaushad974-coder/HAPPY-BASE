import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  BrowserExecutionAdapter,
} from "../../../core/execution/browser-execution-adapter";

import type {
  ExecutionRequest,
} from "../../../core/execution/types";

function assert(
  condition: boolean,
  message: string,
): void {
  if (!condition) {
    throw new Error(message);
  }
}

function startServer(): Promise<{
  server: ReturnType<typeof createServer>;
  port: number;
}> {
  return new Promise((resolve) => {
    const server =
      createServer(
        (
          _req: IncomingMessage,
          res: ServerResponse,
        ) => {
          res.writeHead(
            200,
            {
              "content-type":
                "text/html",
            },
          );

          res.end(`
<!doctype html>
<html>
<head>
  <title>HAPPY Browser Test</title>
</head>
<body>
  <button id="hello">Hello</button>
  <input id="name" />
  <div id="output">ready</div>
</body>
</html>
          `);
        },
      );

    server.listen(
      0,
      "127.0.0.1",
      () => {
        const address =
          server.address();

        if (
          !address ||
          typeof address === "string"
        ) {
          throw new Error(
            "Could not resolve browser test server port.",
          );
        }

        resolve({
          server,
          port:
            address.port,
        });
      },
    );
  });
}

function makeRequest(
  action: string,¶»§q«^