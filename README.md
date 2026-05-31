# realtime voice component

react/browser voice controls for tool-constrained uis, built on openai realtime.

this is a small library, not a framework. your app defines the exact actions a
voice assistant can take, the assistant calls those actions as tools, and your
ui stays in charge of the visible state change. there is a react controller, an
optional launcher widget, and an optional ghost-cursor overlay for visible
confirmation.

the package is published as `realtime-voice-component`. it is an open-source
reference implementation under apache-2.0. it is not on npm and `package.json`
stays private. treat it as something to read, run, and adapt, not as a
long-term supported ui kit.

## why this exists

raw realtime gives you a transport and a session. that is the right tool when
you want custom audio, a non-react runtime, or your own ui from scratch.

but a lot of apps want something narrower. let the user talk, have the model
call a few app-owned actions, and keep the app as the source of truth. doing
that by hand means handling the sdp exchange, session config, tool-call
plumbing, transcript assembly, and connection lifecycle every single time.

this package does that part once. it keeps the cascaded realtime stack and wraps
it in a controller you drive from react, so your time goes to the tools and the
ui instead of the transport.

## what it's for

reach for this when:

- your app owns the actions and wants them to stay narrow
- the ui, not the model, performs the visible change
- you want a react-friendly controller and an optional launcher widget
- one or two tools map cleanly onto real app handlers

reach for something else when:

- you need custom audio or a non-react runtime, use raw realtime
- you need agent orchestration, handoffs, or hosted-tool and mcp flows, use
  [`openai-agents-js`](https://github.com/openai/openai-agents-js)

## how it fits together

the flow is the normal realtime loop, with your app owning both ends.

```text
mic -> webrtc -> openai realtime -> tool call -> your app handler -> ui update
                                              -> state sync back into the session
```

the browser never talks to openai directly. it posts its sdp offer and session
config to a `/session` endpoint you own, and your server forwards that to the
realtime api with your key.

```text
browser  --sdp + session config-->  your /session  --forwards-->  api.openai.com
         <----- answer sdp --------                 <-- answer ---
```

## package shape

- `defineVoiceTool()` turns a zod-backed app action into a realtime function
  tool. plain json schema is rejected on purpose. zod is required.
- `createVoiceControlController()` owns the session, transport, tool execution,
  transcript assembly, and connection lifecycle. it is plain typescript with no
  react dependency.
- `useVoiceControl()` binds react to a controller. pass options and the hook
  owns creation and teardown. pass a controller and your app owns its lifecycle.
- `VoiceControlWidget` is a launcher ui on top of the controller. keep it thin.
- `useGhostCursor()` and `GhostCursorOverlay` are optional visible-confirmation
  helpers for tool calls.
- `createUltravoxTransport()` swaps the openai transport for ultravox v0.7
  without touching your tools. see below.

## the /session proxy

add one route to your app backend. it forwards the browser's multipart body to
`POST https://api.openai.com/v1/realtime/calls` and returns the answer sdp. keep
the body intact unless you mean to override session settings.

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

the key never reaches the browser. the demo's `demo/session-server.mjs` is a
~60-line version of exactly this route.

## defining a tool and a controller

tools call your app handlers, and handlers do the real work. a tool's
`execute()` should not become a second business-logic layer.

```tsx
const tools = [
  defineVoiceTool({
    name: "set_prompt",
    description: "Replace the current prompt.",
    parameters: z.object({ prompt: z.string().min(1) }),
    execute: ({ prompt }) => {
      app.setPrompt(prompt);
      return { ok: true, prompt };
    },
  }),
];

const controller = createVoiceControlController({
  activationMode: "vad",
  auth: { sessionEndpoint: "/session" },
  instructions:
    "Use the provided tools to control the current screen. Prefer tools over free-form responses.",
  outputMode: "tool-only",
  tools,
});
```

bind it in react. if you pass the controller in, your app owns `destroy()`.

```tsx
const runtime = useVoiceControl(controller);
// ...
<VoiceControlWidget controller={controller} snapToCorners />;
```

## swapping in ultravox

the controller is transport-agnostic. `createUltravoxTransport()` runs the same
tool-call shape on [ultravox v0.7](https://ultravox.ai), a hosted speech-native
model, at roughly 6x lower cost. your `defineVoiceTool(...)` definitions and the
rest of the runtime stay the same.

```tsx
import { createUltravoxTransport, createVoiceControlController } from "realtime-voice-component";

createVoiceControlController({
  auth: { sessionEndpoint: "/ultravox/call" },
  model: "ultravox-v0.7",
  transportFactory: () => createUltravoxTransport({ callEndpoint: "/ultravox/call" }),
  tools,
  instructions,
});
```

the matching server route forwards to `POST https://api.ultravox.ai/api/calls`
with your `ULTRAVOX_API_KEY` and returns the call's `joinUrl`.

```text
browser  --call config-->  your /ultravox/call  --forwards-->  api.ultravox.ai
         <----- joinUrl ---                       <-- joinUrl --
browser  <========== webrtc audio + data ==========>  ultravox call
```

under the hood the transport translates ultravox's data-message protocol into
the openai-realtime-shaped events the controller already decodes, so your tools
do not know the difference. `ultravox-client` is an optional peer dependency,
install it only when you take this path. `demo/ultravox-call-server.mjs` is the
matching proxy, and
[docs/controller-runtime.md](./docs/controller-runtime.md#swapping-transports)
plus [docs/authentication.md](./docs/authentication.md) cover the rest.

## demo app

`demo/` is the main runnable teaching surface. it shows a theme-switch flow, a
multi-step form, a shared-state chess flow, one controller reused across
screens, and optional wake-word experimentation on top.

```powershell
Copy-Item demo\.env.example demo\.env.local
# edit demo\.env.local and set OPENAI_API_KEY (and ULTRAVOX_API_KEY for ultravox)
corepack pnpm install
corepack pnpm demo
```

`corepack pnpm demo` starts the `/session` proxy (port 3211), the
`/ultravox/call` proxy (port 3212), and the vite dev server together. set
`VITE_VOICE_PROVIDER=ultravox` in `demo\.env.local` to run the same demos
against ultravox instead of openai.

## turn detection defaults

the controller uses realtime `server_vad` by default. for text and tool-only
sessions it also sets `interrupt_response: false`, so a stray utterance does not
cancel an in-flight text response or tool call. that matters when your ui does
not play assistant audio back to the user.

if you override `audio.input.turnDetection`, this server-vad shape is a good
starting point for tool-only ui control.

```ts
{
  type: "server_vad",
  threshold: 0.5,
  prefixPaddingMs: 300,
  silenceDurationMs: 200,
  createResponse: true,
  interruptResponse: false,
}
```

other defaults worth knowing: model `gpt-realtime-1.5`, activation mode `vad`,
and a strong lean toward `tool-only` output for ui control.

## integrating with an existing app

the reliable retrofit pattern is small and boring on purpose.

1. keep your app as the source of truth.
2. add the `/session` route above.
3. put a small app-owned adapter between tools and your real handlers, with
   methods like `getState()`, `setPrompt()`, and `startRun()`.
4. register narrow tools against that adapter, one tool per real action.
5. create the controller at the layer that owns the voice surface. that is one
   screen, or a shell/provider if the same session must survive route changes.
6. if you pass an external controller into `useVoiceControl(controller)` or
   `VoiceControlWidget`, that same layer owns `destroy()`.
7. after a visible change, send current ui state back into the session so the
   model stays grounded in what is actually on screen.

two things that cost real debugging time:

- do not destroy an externally owned controller from a leaf component cleanup.
  react strict-mode remounts can leave a mounted widget holding a dead
  controller that silently never connects.
- if the widget stays at `idle` and never hits `/session`, suspect controller
  ownership and browser media/webrtc support before blaming the backend.

prefer stable tool definitions. if a tool only needs the latest state, read it
through a ref or selector instead of rebuilding the whole tool set every render.
[docs/integrating-with-an-existing-app.md](./docs/integrating-with-an-existing-app.md)
walks through the full version.

## local install

this repo is optimized for local open-source use, not an npm release. install it
into another app from a local checkout.

```powershell
pnpm add ../path/to/realtime-voice-component zod
pnpm add ultravox-client   # only if you use the ultravox transport
```

then import from `realtime-voice-component` and
`realtime-voice-component/styles.css`.

## docs

- [docs overview](./docs/README.md)
- [getting started](./docs/getting-started.md)
- [integrating with an existing app](./docs/integrating-with-an-existing-app.md)
- [architecture choices](./docs/architecture-choices.md)
- [controller and runtime](./docs/controller-runtime.md)
- [widget and ghost cursor](./docs/widget-and-cursor.md)
- [authentication](./docs/authentication.md)
- [showcase demo architecture](./docs/demo-architecture.md)
- [api reference](./docs/api-reference.md)

## current limits

- the widget is a launcher, not a full ui. if you need richer capture controls,
  a transcript surface, or a more opinionated layout, build on the controller
  directly.
- this is browser-first. there is no server-side or non-react runtime story.
- it is a reference implementation, not a supported product. apis and defaults
  can change, and you should expect to read the source while adopting it.
- the ultravox transport covers the tool-call path the controller uses, not
  every openai realtime feature.

## license

apache-2.0. see [LICENSE](./LICENSE).
