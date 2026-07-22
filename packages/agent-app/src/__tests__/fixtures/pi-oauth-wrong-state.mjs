import { createServer, Server } from "node:http";

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = 53692;
const REPORT_PREFIX = "mono-agent-pi-oauth-wrong-state:";
const WRONG_STATE_REDIRECT =
  "http://localhost:53692/callback?code=untrusted-code&state=wrong-state";

const occupation = await occupyFixedCallbackPort();
const hadOwnListen = Object.hasOwn(Server.prototype, "listen");
const originalListen = Server.prototype.listen;
const originalFetch = globalThis.fetch;
let fallbackPrompts = 0;
let interceptedBinds = 0;
let isolatedPort;
let manualInputs = 0;
let tokenExchangeAttempts = 0;

// Pi 0.80.5 owns the callback server and hard-codes its port. Keep its real
// server lifecycle, parser, and state validation, but isolate only that exact
// bind so an unrelated host listener cannot preempt the contract assertion.
Server.prototype.listen = function (port, host, callback) {
  if (port !== CALLBACK_PORT || host !== CALLBACK_HOST || typeof callback !== "function") {
    return Reflect.apply(originalListen, this, arguments);
  }

  interceptedBinds += 1;
  if (interceptedBinds !== 1) {
    throw new Error(`Expected one Pi callback bind, received ${interceptedBinds}`);
  }

  const callbackServer = this;
  return Reflect.apply(originalListen, callbackServer, [0, CALLBACK_HOST, () => {
    const address = callbackServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Pi callback isolation did not create a TCP listener");
    }
    isolatedPort = address.port;
    callback();
  }]);
};

globalThis.fetch = async () => {
  tokenExchangeAttempts += 1;
  throw new Error("The wrong-state fixture attempted a live OAuth token exchange");
};

let observedError;
try {
  const { loginAnthropic } = await import("@earendil-works/pi-ai/oauth");
  try {
    await loginAnthropic({
      onAuth: () => undefined,
      onPrompt: async () => {
        fallbackPrompts += 1;
        throw new Error("The wrong-state fixture reached Pi's fallback prompt");
      },
      onManualCodeInput: async () => {
        manualInputs += 1;
        return WRONG_STATE_REDIRECT;
      },
    });
  } catch (error) {
    observedError = error;
  }

  if (!(observedError instanceof Error) || observedError.message !== "OAuth state mismatch") {
    throw observedError instanceof Error
      ? new Error(`Expected exact OAuth state mismatch, received: ${observedError.message}`)
      : new Error("Expected exact OAuth state mismatch, but Pi resolved successfully");
  }
  if (interceptedBinds !== 1 || isolatedPort === undefined) {
    throw new Error("Pi did not use the isolated fixed-port callback bind exactly once");
  }
  if (fallbackPrompts !== 0 || manualInputs !== 1 || tokenExchangeAttempts !== 0) {
    throw new Error("Pi did not reject the pasted redirect on the manual wrong-state path");
  }
} finally {
  globalThis.fetch = originalFetch;
  if (hadOwnListen) Server.prototype.listen = originalListen;
  else delete Server.prototype.listen;
  await closeServer(occupation.server);
}

process.stdout.write(`${REPORT_PREFIX}${JSON.stringify({
  error: observedError.message,
  fallbackPrompts,
  fixedPort: CALLBACK_PORT,
  interceptedBinds,
  isolatedPort,
  manualInputs,
  occupation: occupation.owner,
  tokenExchangeAttempts,
})}\n`);

async function occupyFixedCallbackPort() {
  const blocker = createServer((_request, response) => {
    response.writeHead(503, { Connection: "close" });
    response.end();
  });
  return await new Promise((resolve, reject) => {
    const onError = (error) => {
      if (error?.code === "EADDRINUSE") {
        resolve({ owner: "ambient", server: undefined });
        return;
      }
      reject(error);
    };
    blocker.once("error", onError);
    blocker.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      blocker.off("error", onError);
      resolve({ owner: "fixture", server: blocker });
    });
  });
}

async function closeServer(server) {
  if (server === undefined) return;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
    server.closeAllConnections();
  });
}
