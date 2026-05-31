# Authentication

Use a server endpoint to proxy the browser WebRTC offer to OpenAI.

Do not use a standard OpenAI API key in the browser.

## `sessionEndpoint`

Pass:

```tsx
auth={{ sessionEndpoint: "/session" }}
```

This is the canonical auth contract for the repo.

The client will:

- create the local SDP offer in the browser
- send a `POST /session` multipart request with `sdp` and serialized session config
- expect your server to return the answer SDP from OpenAI

If you need custom headers or credentials, use `sessionRequestInit`:

```tsx
auth={{
  sessionEndpoint: "/session",
  sessionRequestInit: {
    credentials: "include"
  }
}}
```

Leave the incoming multipart body untouched unless you intentionally want to
merge or override the session on your server before forwarding it to OpenAI.

Example Express handler:

```ts
app.post("/session", async (request, response) => {
  const contentType = request.header("content-type");

  const realtimeResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      ...(contentType ? { "Content-Type": contentType } : {}),
    },
    body: request,
    duplex: "half",
  });

  response
    .status(realtimeResponse.status)
    .type(realtimeResponse.headers.get("content-type") ?? "application/sdp")
    .send(await realtimeResponse.text());
});
```

## Ultravox Transport

When using `createUltravoxTransport`, the same `sessionEndpoint` shape is reused
to identify a server-side proxy that issues Ultravox calls. Point it at your own
`/ultravox/call` route:

```tsx
auth={{ sessionEndpoint: "/ultravox/call" }}
```

The proxy receives JSON, not multipart, and forwards the request to
`POST https://api.ultravox.ai/api/calls` with your `X-API-Key` header. Return
the JSON response (`{ joinUrl, callId }`) untouched. Example Node handler:

```ts
app.post("/ultravox/call", async (request, response) => {
  const upstream = await fetch("https://api.ultravox.ai/api/calls", {
    method: "POST",
    headers: {
      "X-API-Key": process.env.ULTRAVOX_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...request.body, medium: { webRtc: {} } }),
  });
  response.status(upstream.status).type("application/json").send(await upstream.text());
});
```

The browser never sees the Ultravox API key. See
[`demo/ultravox-call-server.mjs`](../demo/ultravox-call-server.mjs) for the
runnable reference.

## Legacy Compatibility

The library still supports the older client-secret bootstrap paths:

- `auth={{ tokenEndpoint: "/token" }}`
- `auth={{ getClientSecret: async () => "..." }}`

Use these only if you specifically want the browser to POST SDP directly to
OpenAI with a short-lived client secret. They are compatibility paths, not the
recommended quickstart.

## `getClientSecret`

If you already have your own fetch path, pass an async loader instead:

```tsx
auth={{
  getClientSecret: async () => {
    const response = await fetch("/token");
    const payload = await response.json();
    return payload.value ?? payload.client_secret?.value;
  }
}}
```

Use this only for the legacy client-secret flow when you want full control over
retries, auth headers, or request flow.
