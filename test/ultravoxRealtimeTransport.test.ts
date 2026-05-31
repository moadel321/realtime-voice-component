import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  RealtimeServerEvent,
  RealtimeFunctionTool,
} from "../src/types";
import type { TransportConnectOptions } from "../src/transport/types";

const fakeFetch = vi.fn();

const sdkState = vi.hoisted(() => ({
  registered: new Map<string, (params: Record<string, unknown>) => unknown>(),
  joinUrls: [] as string[],
  leaveCalls: 0,
  setOutputMediumCalls: [] as string[],
  sendDataCalls: [] as unknown[],
  sendTextCalls: [] as Array<{ text: string; defer: boolean }>,
  muteMicCalls: 0,
  unmuteMicCalls: 0,
  status: "disconnected" as string,
  transcripts: [] as Array<{
    text: string;
    isFinal: boolean;
    speaker: string;
    medium: string;
    ordinal: number;
  }>,
  listeners: new Map<string, Set<() => void>>(),
}));

vi.mock("ultravox-client", () => {
  const UltravoxSessionStatus = {
    DISCONNECTED: "disconnected",
    DISCONNECTING: "disconnecting",
    CONNECTING: "connecting",
    IDLE: "idle",
    LISTENING: "listening",
    THINKING: "thinking",
    SPEAKING: "speaking",
  } as const;

  const Role = { USER: "user", AGENT: "agent" } as const;
  const Medium = { VOICE: "voice", TEXT: "text" } as const;
  const AgentReaction = {
    SPEAKS: "speaks",
    LISTENS: "listens",
    SPEAKS_ONCE: "speaks-once",
  } as const;

  class UltravoxSession {
    registerToolImplementation(
      name: string,
      implementation: (params: Record<string, unknown>) => unknown,
    ) {
      sdkState.registered.set(name, implementation);
    }

    addEventListener(type: string, listener: () => void) {
      let set = sdkState.listeners.get(type);
      if (!set) {
        set = new Set();
        sdkState.listeners.set(type, set);
      }
      set.add(listener);
    }

    removeEventListener(type: string, listener: () => void) {
      sdkState.listeners.get(type)?.delete(listener);
    }

    joinCall(joinUrl: string) {
      sdkState.joinUrls.push(joinUrl);
      sdkState.status = UltravoxSessionStatus.CONNECTING;
      const listeners = sdkState.listeners.get("status");
      if (!listeners) return;
      for (const listener of Array.from(listeners)) {
        listener();
      }
    }

    async leaveCall() {
      sdkState.leaveCalls += 1;
    }

    setOutputMedium(medium: string) {
      sdkState.setOutputMediumCalls.push(medium);
    }

    sendText(text: string, defer?: boolean) {
      sdkState.sendTextCalls.push({ text, defer: Boolean(defer) });
    }

    sendData(obj: unknown) {
      sdkState.sendDataCalls.push(obj);
    }

    muteMic() {
      sdkState.muteMicCalls += 1;
    }

    unmuteMic() {
      sdkState.unmuteMicCalls += 1;
    }

    muteSpeaker() {}
    unmuteSpeaker() {}

    get status() {
      return sdkState.status;
    }

    get transcripts() {
      return sdkState.transcripts;
    }
  }

  return {
    UltravoxSession,
    UltravoxSessionStatus,
    Role,
    Medium,
    AgentReaction,
  };
});

const fireListener = (type: string) => {
  const listeners = sdkState.listeners.get(type);
  if (!listeners) return;
  for (const listener of Array.from(listeners)) {
    listener();
  }
};

const setStatus = (status: string) => {
  sdkState.status = status;
  fireListener("status");
};

const setTranscripts = (
  transcripts: Array<{
    text: string;
    isFinal: boolean;
    speaker: string;
    medium?: string;
    ordinal: number;
  }>,
) => {
  sdkState.transcripts = transcripts.map((t) => ({
    text: t.text,
    isFinal: t.isFinal,
    speaker: t.speaker,
    medium: t.medium ?? "voice",
    ordinal: t.ordinal,
  }));
  fireListener("transcripts");
};

const flushPromises = async () => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
};

beforeEach(() => {
  sdkState.registered.clear();
  sdkState.joinUrls = [];
  sdkState.leaveCalls = 0;
  sdkState.setOutputMediumCalls = [];
  sdkState.sendDataCalls = [];
  sdkState.sendTextCalls = [];
  sdkState.muteMicCalls = 0;
  sdkState.unmuteMicCalls = 0;
  sdkState.status = "disconnected";
  sdkState.transcripts = [];
  sdkState.listeners = new Map();
  fakeFetch.mockReset();
  globalThis.fetch = fakeFetch as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function startTransportConnect(
  overrides: Partial<TransportConnectOptions["session"]> = {},
  audioPlaybackEnabled = true,
  signal?: AbortSignal,
) {
  const { createUltravoxTransport } = await import("../src/transport/ultravoxRealtimeTransport");
  const onServerEvent = vi.fn<(event: RealtimeServerEvent) => void>();
  const onError = vi.fn<(error: Error) => void>();

  const tools: RealtimeFunctionTool[] = overrides.tools ?? [
    {
      type: "function",
      name: "set_theme",
      description: "Switch theme",
      parameters: {
        type: "object",
        properties: {
          theme: { type: "string", enum: ["light", "dark"] },
        },
        required: ["theme"],
      },
    },
  ];

  const session: TransportConnectOptions["session"] = {
    model: "ultravox-v0.7",
    instructions: "You are the test agent.",
    tools,
    activationMode: overrides.activationMode ?? "vad",
    outputMode: overrides.outputMode ?? "text+audio",
  };

  fakeFetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ joinUrl: "wss://example/join", callId: "call-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );

  const transport = createUltravoxTransport({ callEndpoint: "/ultravox/call" });

  const connectPromise = transport.connect({
    auth: { type: "session_endpoint", sessionEndpoint: "/ultravox/call" },
    session,
    audioPlaybackEnabled,
    ...(signal ? { signal } : {}),
    onServerEvent,
    onError,
  });

  return { transport, onServerEvent, onError, session, connectPromise };
}

async function makeTransport(
  overrides: Partial<TransportConnectOptions["session"]> = {},
  audioPlaybackEnabled = true,
) {
  const harness = await startTransportConnect(overrides, audioPlaybackEnabled);
  await vi.waitFor(() => {
    expect(sdkState.joinUrls).toHaveLength(1);
  });
  setStatus("listening");
  await harness.connectPromise;

  return harness;
}

describe("createUltravoxTransport", () => {
  it("posts the configured call body and joins with the returned URL", async () => {
    const { onServerEvent } = await makeTransport();

    expect(fakeFetch).toHaveBeenCalledOnce();
    const [endpoint, init] = fakeFetch.mock.calls[0]!;
    expect(endpoint).toBe("/ultravox/call");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.systemPrompt).toBe("You are the test agent.");
    expect(body.model).toBe("ultravox-v0.7");
    expect(body.firstSpeakerSettings).toEqual({ user: {} });
    expect(body.initialOutputMedium).toBe("MESSAGE_MEDIUM_VOICE");
    expect(body.selectedTools).toEqual([
      {
        temporaryTool: {
          modelToolName: "set_theme",
          description: "Switch theme",
          dynamicParameters: [
            {
              name: "theme",
              location: "PARAMETER_LOCATION_BODY",
              schema: { type: "string", enum: ["light", "dark"] },
              required: true,
            },
          ],
          client: {},
        },
      },
    ]);

    expect(sdkState.joinUrls).toEqual(["wss://example/join"]);
    expect(onServerEvent).not.toHaveBeenCalled();
  });

  it("does not resolve connect until the SDK reaches a sendable status", async () => {
    const { connectPromise } = await startTransportConnect();
    let resolved = false;
    void connectPromise.then(
      () => {
        resolved = true;
      },
      () => {},
    );

    await vi.waitFor(() => {
      expect(sdkState.joinUrls).toEqual(["wss://example/join"]);
    });
    await flushPromises();

    expect(sdkState.status).toBe("connecting");
    expect(resolved).toBe(false);

    setStatus("idle");
    await flushPromises();
    expect(resolved).toBe(false);

    setStatus("listening");
    await connectPromise;
    expect(resolved).toBe(true);
  });

  it(
    "times out and leaves the call if the SDK never becomes ready",
    async () => {
      vi.useFakeTimers();
      const { connectPromise } = await startTransportConnect();
      const rejection = expect(connectPromise).rejects.toThrow(
        /Timed out waiting 15000ms for the Ultravox session to become ready/,
      );

      await vi.waitFor(() => {
        expect(sdkState.joinUrls).toEqual(["wss://example/join"]);
      });
      expect(sdkState.status).toBe("connecting");

      await vi.advanceTimersByTimeAsync(15_000);
      await rejection;
      expect(sdkState.leaveCalls).toBe(1);
    },
    20_000,
  );

  it("aborts the ready wait and leaves the call", async () => {
    const abortController = new AbortController();
    const { connectPromise } = await startTransportConnect({}, true, abortController.signal);
    const rejection = expect(connectPromise).rejects.toMatchObject({
      code: "aborted",
      name: "AbortError",
    });

    await vi.waitFor(() => {
      expect(sdkState.joinUrls).toEqual(["wss://example/join"]);
    });

    abortController.abort();
    await rejection;
    expect(sdkState.leaveCalls).toBe(1);
  });

  it("translates tool-only output mode to text initial medium", async () => {
    await makeTransport({ outputMode: "tool-only" }, false);
    const body = JSON.parse((fakeFetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.initialOutputMedium).toBe("MESSAGE_MEDIUM_TEXT");
  });

  it("emits response.created and function_call on Ultravox tool invocation, then resolves with agentReaction listens", async () => {
    const { transport, onServerEvent } = await makeTransport();

    setStatus("listening");
    setStatus("thinking");

    const created = onServerEvent.mock.calls.find((c) => c[0]?.type === "response.created");
    expect(created).toBeDefined();
    const responseId = (created![0] as unknown as { response: { id: string } }).response.id;

    const impl = sdkState.registered.get("set_theme");
    expect(impl).toBeDefined();

    const resultPromise = impl!({ theme: "dark" }) as Promise<{
      result: string;
      responseType: string;
      agentReaction?: string | null;
    }>;

    const itemEvent = onServerEvent.mock.calls.find((c) => c[0]?.type === "response.output_item.done");
    expect(itemEvent).toBeDefined();
    const item = (
      itemEvent![0] as unknown as { item: { call_id: string; name: string; arguments: string } }
    ).item;
    expect(item.name).toBe("set_theme");
    expect(JSON.parse(item.arguments)).toEqual({ theme: "dark" });
    const callId = item.call_id;

    transport.sendFunctionResult(callId, { ok: true, theme: "dark" });

    const resolved = await resultPromise;
    expect(resolved.agentReaction).toBe("listens");
    expect(resolved.responseType).toBe("tool-response");
    expect(JSON.parse(resolved.result)).toEqual({ ok: true, theme: "dark" });

    const done = onServerEvent.mock.calls.find((c) => c[0]?.type === "response.done");
    expect(done).toBeDefined();
    expect((done![0] as unknown as { response: { id: string } }).response.id).toBe(responseId);
  });

  it("ignores sendFunctionResult for unknown callId", async () => {
    const { transport, onServerEvent } = await makeTransport();
    expect(() => transport.sendFunctionResult("does-not-exist", { ok: true })).not.toThrow();
    expect(onServerEvent.mock.calls.find((c) => c[0]?.type === "response.done")).toBeUndefined();
  });

  it("forwards transcripts as audio_transcript deltas + done with consistent response_id", async () => {
    const { onServerEvent } = await makeTransport();

    setStatus("thinking");
    setTranscripts([
      { text: "Hello", isFinal: false, speaker: "agent", ordinal: 0 },
    ]);
    setTranscripts([
      { text: "Hello there", isFinal: false, speaker: "agent", ordinal: 0 },
    ]);
    setTranscripts([
      { text: "Hello there.", isFinal: true, speaker: "agent", ordinal: 0 },
    ]);

    const deltas = onServerEvent.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === "response.output_audio_transcript.delta");
    expect(deltas.map((e) => (e as unknown as { delta: string }).delta)).toEqual([
      "Hello",
      " there",
      ".",
    ]);

    const final = onServerEvent.mock.calls
      .map((c) => c[0])
      .find((e) => e.type === "response.output_audio_transcript.done");
    expect(final).toBeDefined();
    expect((final as unknown as { transcript: string }).transcript).toBe("Hello there.");

    const responseIds = new Set(
      onServerEvent.mock.calls
        .map((c) => c[0])
        .filter(
          (e) =>
            e.type === "response.output_audio_transcript.delta" ||
            e.type === "response.output_audio_transcript.done",
        )
        .map((e) => (e as unknown as { response_id: string }).response_id),
    );
    expect(responseIds.size).toBe(1);
  });

  it("translates system conversation items to deferred sendText with [State update] prefix", async () => {
    const { transport } = await makeTransport();
    transport.sendClientEvent({
      type: "conversation.item.create",
      item: {
        role: "system",
        content: [{ type: "input_text", text: "theme is dark" }],
      },
    });
    expect(sdkState.sendTextCalls).toEqual([
      { text: "[State update] theme is dark", defer: true },
    ]);
  });

  it("ignores non-system passthrough client events", async () => {
    const { transport } = await makeTransport();
    transport.sendClientEvent({ type: "input_audio_buffer.clear" });
    expect(sdkState.sendTextCalls).toEqual([]);
    expect(sdkState.sendDataCalls).toEqual([]);
  });

  it("requestResponse sends forced_agent_message via sendData", async () => {
    const { transport } = await makeTransport();
    transport.requestResponse();
    expect(sdkState.sendDataCalls).toEqual([
      { type: "forced_agent_message", content: "", urgency: "soon" },
    ]);
  });

  it("setAudioPlaybackEnabled toggles outputMedium without using muteSpeaker", async () => {
    const { transport } = await makeTransport();
    transport.setAudioPlaybackEnabled(false);
    transport.setAudioPlaybackEnabled(true);
    expect(sdkState.setOutputMediumCalls).toEqual(["text", "voice"]);
  });

  it("disconnect rejects pending invocations and is idempotent", async () => {
    const { transport } = await makeTransport();

    setStatus("thinking");
    const impl = sdkState.registered.get("set_theme");
    const pending = impl!({ theme: "dark" }) as Promise<unknown>;

    transport.disconnect();
    transport.disconnect();
    await expect(pending).rejects.toThrow(/disconnected/i);
    expect(sdkState.leaveCalls).toBe(1);
  });

  it("PTT activation mode mutes the mic on connect, unmutes on startCapture, mutes on stopCapture", async () => {
    const { transport } = await makeTransport({ activationMode: "push-to-talk" });
    expect(sdkState.muteMicCalls).toBe(1);
    transport.startCapture();
    transport.stopCapture();
    expect(sdkState.unmuteMicCalls).toBe(1);
    expect(sdkState.muteMicCalls).toBe(2);
  });

  it("postToolResponse sequence: tool call → response.done → requestResponse → second response.created", async () => {
    const { transport, onServerEvent } = await makeTransport();

    setStatus("listening");
    setStatus("thinking");

    const impl = sdkState.registered.get("set_theme");
    const pending = impl!({ theme: "dark" }) as Promise<unknown>;
    const itemEvent = onServerEvent.mock.calls.find((c) => c[0]?.type === "response.output_item.done");
    const callId = (itemEvent![0] as unknown as { item: { call_id: string } }).item.call_id;
    const firstResponseId = (
      onServerEvent.mock.calls.find((c) => c[0]?.type === "response.created")![0] as unknown as {
        response: { id: string };
      }
    ).response.id;

    transport.sendFunctionResult(callId, { ok: true });
    await pending;

    const firstDone = onServerEvent.mock.calls
      .map((c) => c[0])
      .find((e) => e.type === "response.done");
    expect((firstDone as unknown as { response: { id: string } }).response.id).toBe(
      firstResponseId,
    );

    // Ultravox naturally transitions back to listening after agentReaction: "listens".
    setStatus("listening");

    onServerEvent.mockClear();
    transport.requestResponse();
    expect(sdkState.sendDataCalls.at(-1)).toEqual({
      type: "forced_agent_message",
      content: "",
      urgency: "soon",
    });

    setStatus("thinking");
    const secondCreated = onServerEvent.mock.calls.find((c) => c[0]?.type === "response.created");
    expect(secondCreated).toBeDefined();
    const secondResponseId = (secondCreated![0] as unknown as { response: { id: string } })
      .response.id;
    expect(secondResponseId).not.toBe(firstResponseId);

    setStatus("listening");
    const secondDone = onServerEvent.mock.calls
      .map((c) => c[0])
      .find((e) => e.type === "response.done");
    expect((secondDone as unknown as { response: { id: string } }).response.id).toBe(
      secondResponseId,
    );
  });
});
