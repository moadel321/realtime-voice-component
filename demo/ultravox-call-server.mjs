import { createServer } from "node:http";

const port = Number(process.env.DEMO_ULTRAVOX_PORT ?? 3212);

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "GET" && requestUrl.pathname === "/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method !== "POST" || requestUrl.pathname !== "/ultravox/call") {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  const apiKey = process.env.ULTRAVOX_API_KEY;
  if (!apiKey) {
    sendJson(response, 500, {
      error: "Missing ULTRAVOX_API_KEY in the environment.",
    });
    return;
  }

  let clientPayload;
  try {
    clientPayload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : "Invalid JSON body.",
    });
    return;
  }

  const callBody = {
    ...clientPayload,
    medium: { webRtc: {} },
  };

  try {
    const ultravoxResponse = await fetch("https://api.ultravox.ai/api/calls", {
      method: "POST",
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(callBody),
    });

    const responseText = await ultravoxResponse.text();

    if (!ultravoxResponse.ok) {
      response.writeHead(ultravoxResponse.status, {
        "Content-Type": ultravoxResponse.headers.get("content-type") ?? "application/json",
      });
      response.end(responseText);
      return;
    }

    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
    });
    response.end(responseText);
  } catch (error) {
    sendJson(response, 502, {
      error: error instanceof Error ? error.message : "Upstream Ultravox call failed.",
    });
  }
});

server.listen(port, () => {
  console.log(`Demo Ultravox call server listening on http://localhost:${port}`);
});
