import {
  AgentReaction,
  Medium,
  Role,
  UltravoxSession,
  UltravoxSessionStatus,
  type Transcript,
} from "ultravox-client";

import type { JsonSchema, RealtimeClientEvent, RealtimeServerEvent } from "../types";

import { createAbortError, throwIfAborted } from "./_shared";
import type {
  RealtimeTransport,
  TransportConnectOptions,
  TransportSessionConfig,
} from "./types";

const DEFAULT_ULTRAVOX_MODEL = "ultravox-v0.7";
const STATE_UPDATE_PREFIX = "[State update] ";
const ULTRAVOX_READY_TIMEOUT_MS = 15_000;

export type UltravoxTransportOptions = {
  /**
   * URL the transport posts to in order to create a call. The endpoint must
   * proxy the body to `POST https://api.ultravox.ai/api/calls` and return
   * the JSON response (`{ joinUrl, callId, ... }`). Defaults to `/ultravox/call`.
   */
  callEndpoint?: string;
  /**
   * Optional voice id (e.g. "Mark"). Falls back to Ultravox's default voice.
   */
  voice?: string;
  /**
   * Optional override for the Ultravox model. Defaults to "ultravox-v0.7".
   */
  defaultModel?: string;
  /**
   * Hook for tests and tracing. Receives every synthetic OpenAI-shaped server
   * event before it is forwarded to the controller.
   */
  debug?: (label: string, payload?: unknown) => void;
};

type PendingInvocation = {
  resolve: (
    value:
      | string
      | {
          result: string;
          responseType: string;
          agentReaction?: AgentReaction | null;
          updateCallState?: Record<string, unknown> | null;
        },
  ) => void;
  reject: (reason: Error) => void;
  responseId: string;
};

type UltravoxToolDefinition = {
  temporaryTool: {
    modelToolName: string;
    description: string;
    dynamicParameters: Array<{
      name: string;
      location: "PARAMETER_LOCATION_BODY";
      schema: JsonSchema;
      required: boolean;
    }>;
    client: Record<string, never>;
  };
};

type UltravoxMessageMedium = "MESSAGE_MEDIUM_VOICE" | "MESSAGE_MEDIUM_TEXT";

type CreateCallRequest = {
  systemPrompt: string;
  model: string;
  voice?: string;
  selectedTools?: UltravoxToolDefinition[];
  firstSpeakerSettings?: { user: Record<string, never> } | { agent: Record<string, never> };
  initialOutputMedium?: UltravoxMessageMedium;
};

type CreateCallResponse = {
  joinUrl: string;
  callId?: string;
};

function isUltravoxReadyStatus(status: UltravoxSessionStatus) {
  return (
    status === UltravoxSessionStatus.LISTENING ||
    status === UltravoxSessionStatus.THINKING ||
    status === UltravoxSessionStatus.SPEAKING
  );
}

function isUltravoxConnectFailureStatus(status: UltravoxSessionStatus) {
  return (
    status === UltravoxSessionStatus.DISCONNECTED ||
    status === UltravoxSessionStatus.DISCONNECTING
  );
}

function waitForUltravoxReady(
  session: UltravoxSession,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      settle(
        new Error(
          `Timed out waiting ${ULTRAVOX_READY_TIMEOUT_MS}ms for the Ultravox session to become ready.`,
        ),
      );
    }, ULTRAVOX_READY_TIMEOUT_MS);

    const cleanup = () => {
      session.removeEventListener("status", handleStatus);
      signal?.removeEventListener("abort", handleAbort);

      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const settle = (error?: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      if (error) {
        reject(error);
        return;
      }

      resolve();
    };

    const inspectStatus = () => {
      const status = session.status;

      if (isUltravoxReadyStatus(status)) {
        settle();
        return;
      }

      if (isUltravoxConnectFailureStatus(status)) {
        settle(new Error(`Ultravox session ${status} before it became ready.`));
      }
    };

    function handleStatus() {
      inspectStatus();
    }

    function handleAbort() {
      settle(createAbortError());
    }

    session.addEventListener("status", handleStatus);
    signal?.addEventListener("abort", handleAbort, { once: true });
    inspectStatus();
  });
}

function jsonSchemaToUltravoxParams(schema: JsonSchema): UltravoxToolDefinition["temporaryTool"]["dynamicParameters"] {
  const properties = schema.properties ?? {};
  const requiredSet = new Set((schema.required ?? []) as string[]);

  return Object.entries(properties).map(([name, propSchema]) => ({
    name,
    location: "PARAMETER_LOCATION_BODY" as const,
    schema: propSchema,
    required: requiredSet.has(name),
  }));
}

function buildSelectedTools(tools: TransportSessionConfig["tools"]): UltravoxToolDefinition[] {
  return tools.map((tool) => ({
    temporaryTool: {
      modelToolName: tool.name,
      description: tool.description,
      dynamicParameters: jsonSchemaToUltravoxParams(tool.parameters),
      client: {},
    },
  }));
}

function outputModeToMedium(outputMode: TransportSessionConfig["outputMode"]): Medium {
  return outputMode === "audio" || outputMode === "text+audio" ? Medium.VOICE : Medium.TEXT;
}

function audioPlaybackToInitialOutputMedium(audioPlaybackEnabled: boolean): UltravoxMessageMedium {
  return audioPlaybackEnabled ? "MESSAGE_MEDIUM_VOICE" : "MESSAGE_MEDIUM_TEXT";
}

function extractSystemMessageText(event: RealtimeClientEvent): string | null {
  if (event.type !== "conversation.item.create") {
    return null;
  }

  const item = (event as { item?: unknown }).item as
    | {
        role?: string;
        content?: Array<{ type?: string; text?: string }>;
      }
    | undefined;

  if (!item || item.role !== "system" || !item.content) {
    return null;
  }

  const textPart = item.content.find(
    (part) => part?.type === "input_text" && typeof part.text === "string",
  );
  return textPart?.text ?? null;
}

class UltravoxRealtimeTransport implements RealtimeTransport {
  readonly #callEndpoint: string;
  readonly #voice: string | undefined;
  readonly #defaultModel: string;
  readonly #debug: ((label: string, payload?: unknown) => void) | undefined;

  #session: UltravoxSession | null = null;
  #onServerEvent: ((event: RealtimeServerEvent) => void) | null = null;
  #onError: ((error: Error) => void) | null = null;
  #activationMode: TransportSessionConfig["activationMode"] | null = null;
  #outputMode: TransportSessionConfig["outputMode"] | null = null;
  #pendingInvocations = new Map<string, PendingInvocation>();
  #emittedTranscriptOrdinals = new Set<number>();
  #lastEmittedTextByOrdinal = new Map<number, string>();
  #currentResponseId: string | null = null;
  #responseSequence = 0;
  #lastStatus: UltravoxSessionStatus = UltravoxSessionStatus.DISCONNECTED;
  #disconnecting = false;
  #invocationCounter = 0;
  #statusListener: (() => void) | null = null;
  #transcriptsListener: (() => void) | null = null;

  constructor(options: UltravoxTransportOptions = {}) {
    this.#callEndpoint = options.callEndpoint ?? "/ultravox/call";
    this.#voice = options.voice;
    this.#defaultModel = options.defaultModel ?? DEFAULT_ULTRAVOX_MODEL;
    this.#debug = options.debug;
  }

  async connect(options: TransportConnectOptions): Promise<void> {
    if (typeof window === "undefined") {
      throw new Error("Ultravox transport requires a browser environment.");
    }

    throwIfAborted(options.signal);

    this.#onServerEvent = options.onServerEvent;
    this.#onError = options.onError;
    this.#activationMode = options.session.activationMode;
    this.#outputMode = options.session.outputMode;

    const callEndpoint = this.#resolveCallEndpoint(options.auth);
    const requestInit = this.#resolveRequestInit(options.auth);

    const callBody: CreateCallRequest = {
      systemPrompt: options.session.instructions,
      model: options.session.model || this.#defaultModel,
      ...(this.#voice ? { voice: this.#voice } : {}),
      selectedTools: buildSelectedTools(options.session.tools),
      firstSpeakerSettings: { user: {} },
      initialOutputMedium: audioPlaybackToInitialOutputMedium(options.audioPlaybackEnabled),
    };

    let response: Response;
    try {
      response = await fetch(callEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(requestInit?.headers ?? {}),
        },
        body: JSON.stringify(callBody),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(requestInit?.credentials ? { credentials: requestInit.credentials } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted) {
        throw createAbortError();
      }

      throw new Error(
        `Failed to create Ultravox call: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    throwIfAborted(options.signal);

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Failed to create Ultravox call: ${response.status} ${detail}`);
    }

    const payload = (await response.json()) as CreateCallResponse;
    if (!payload.joinUrl) {
      throw new Error("Ultravox call response did not include a joinUrl.");
    }

    throwIfAborted(options.signal);

    const session = new UltravoxSession();
    this.#session = session;

    for (const tool of options.session.tools) {
      session.registerToolImplementation(tool.name, (parameters) =>
        this.#handleClientToolInvocation(tool.name, parameters),
      );
    }

    this.#statusListener = () => this.#handleStatusChange(session.status);
    this.#transcriptsListener = () => this.#handleTranscriptsChange(session.transcripts);
    session.addEventListener("status", this.#statusListener);
    session.addEventListener("transcripts", this.#transcriptsListener);

    if (options.session.activationMode === "push-to-talk") {
      session.muteMic();
    }

    try {
      session.joinCall(payload.joinUrl);
      await waitForUltravoxReady(session, options.signal);
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }

  disconnect(): void {
    if (this.#disconnecting) {
      return;
    }

    this.#disconnecting = true;

    for (const [, pending] of this.#pendingInvocations) {
      pending.reject(new Error("Ultravox call disconnected before tool result was returned."));
    }
    this.#pendingInvocations.clear();

    const session = this.#session;
    if (session) {
      if (this.#statusListener) {
        session.removeEventListener("status", this.#statusListener);
      }
      if (this.#transcriptsListener) {
        session.removeEventListener("transcripts", this.#transcriptsListener);
      }
      void session.leaveCall().catch(() => {});
    }

    this.#session = null;
    this.#statusListener = null;
    this.#transcriptsListener = null;
    this.#onServerEvent = null;
    this.#onError = null;
    this.#currentResponseId = null;
    this.#emittedTranscriptOrdinals.clear();
    this.#lastEmittedTextByOrdinal.clear();
    this.#lastStatus = UltravoxSessionStatus.DISCONNECTED;
    this.#disconnecting = false;
  }

  updateSession(session: TransportSessionConfig): void {
    if (!this.#session) {
      return;
    }

    if (this.#outputMode !== session.outputMode) {
      this.#outputMode = session.outputMode;
      this.#session.setOutputMedium(outputModeToMedium(session.outputMode));
    }

    this.#activationMode = session.activationMode;
  }

  startCapture(): void {
    if (!this.#session || this.#activationMode !== "push-to-talk") {
      return;
    }
    this.#session.unmuteMic();
  }

  stopCapture(): void {
    if (!this.#session || this.#activationMode !== "push-to-talk") {
      return;
    }
    this.#session.muteMic();
  }

  sendFunctionResult(callId: string, output: unknown): void {
    const pending = this.#pendingInvocations.get(callId);
    if (!pending) {
      this.#debug?.("ultravox.tool.result.unknown", { callId });
      return;
    }

    this.#pendingInvocations.delete(callId);

    pending.resolve({
      result: typeof output === "string" ? output : JSON.stringify(output),
      responseType: "tool-response",
      agentReaction: AgentReaction.LISTENS,
    });

    this.#emit({
      type: "response.done",
      response: { id: pending.responseId, output: [] },
    });
    this.#currentResponseId = null;
    this.#emittedTranscriptOrdinals.clear();
    this.#lastEmittedTextByOrdinal.clear();
  }

  requestResponse(): void {
    if (!this.#session) {
      return;
    }

    this.#session.sendData({
      type: "forced_agent_message",
      content: "",
      urgency: "soon",
    });
  }

  sendClientEvent(event: RealtimeClientEvent): void {
    if (!this.#session) {
      return;
    }

    const systemText = extractSystemMessageText(event);
    if (systemText !== null) {
      this.#session.sendText(`${STATE_UPDATE_PREFIX}${systemText}`, true);
      return;
    }

    this.#debug?.("ultravox.passthrough.ignored", event);
  }

  setAudioPlaybackEnabled(enabled: boolean): void {
    if (!this.#session) {
      return;
    }
    this.#session.setOutputMedium(enabled ? Medium.VOICE : Medium.TEXT);
  }

  #resolveCallEndpoint(auth: TransportConnectOptions["auth"]): string {
    if (auth.type === "session_endpoint") {
      return auth.sessionEndpoint;
    }
    return this.#callEndpoint;
  }

  #resolveRequestInit(auth: TransportConnectOptions["auth"]): RequestInit | undefined {
    if (auth.type === "session_endpoint") {
      return auth.sessionRequestInit;
    }
    return undefined;
  }

  #emit(event: RealtimeServerEvent): void {
    this.#debug?.("ultravox.synth.event", event);
    this.#onServerEvent?.(event);
  }

  #ensureResponseStarted(): string {
    if (this.#currentResponseId) {
      return this.#currentResponseId;
    }
    const id = `uv-resp-${++this.#responseSequence}`;
    this.#currentResponseId = id;
    this.#emit({ type: "response.created", response: { id } });
    return id;
  }

  #handleStatusChange(status: UltravoxSessionStatus): void {
    if (status === this.#lastStatus) {
      return;
    }
    const previous = this.#lastStatus;
    this.#lastStatus = status;

    this.#debug?.("ultravox.status", { previous, status });

    if (status === UltravoxSessionStatus.THINKING || status === UltravoxSessionStatus.SPEAKING) {
      this.#ensureResponseStarted();
      return;
    }

    const goneIdle =
      status === UltravoxSessionStatus.LISTENING || status === UltravoxSessionStatus.IDLE;
    const wasActive =
      previous === UltravoxSessionStatus.THINKING ||
      previous === UltravoxSessionStatus.SPEAKING;

    if (goneIdle && wasActive && this.#currentResponseId) {
      const id = this.#currentResponseId;
      this.#currentResponseId = null;
      this.#emittedTranscriptOrdinals.clear();
      this.#lastEmittedTextByOrdinal.clear();
      this.#emit({ type: "response.done", response: { id, output: [] } });
    }

    if (status === UltravoxSessionStatus.DISCONNECTED && !this.#disconnecting) {
      this.#onError?.(new Error("Ultravox session disconnected unexpectedly."));
    }
  }

  #handleTranscriptsChange(transcripts: readonly Transcript[]): void {
    const responseId = this.#ensureResponseStarted();

    for (const transcript of transcripts) {
      if (transcript.speaker !== Role.AGENT) {
        continue;
      }

      const previous = this.#lastEmittedTextByOrdinal.get(transcript.ordinal) ?? "";
      const currentText = transcript.text ?? "";

      if (currentText.length > previous.length) {
        const delta = currentText.slice(previous.length);
        this.#emit({
          type: "response.output_audio_transcript.delta",
          delta,
          response_id: responseId,
        });
        this.#lastEmittedTextByOrdinal.set(transcript.ordinal, currentText);
      }

      if (transcript.isFinal && !this.#emittedTranscriptOrdinals.has(transcript.ordinal)) {
        this.#emittedTranscriptOrdinals.add(transcript.ordinal);
        this.#emit({
          type: "response.output_audio_transcript.done",
          transcript: currentText,
          response_id: responseId,
        });
      }
    }
  }

  #handleClientToolInvocation(
    toolName: string,
    parameters: Record<string, unknown>,
  ): Promise<{
    result: string;
    responseType: string;
    agentReaction?: AgentReaction | null;
  }> {
    const responseId = this.#ensureResponseStarted();
    const invocationId = `uv-tool-${++this.#invocationCounter}`;

    return new Promise((resolve, reject) => {
      this.#pendingInvocations.set(invocationId, {
        resolve: resolve as PendingInvocation["resolve"],
        reject,
        responseId,
      });

      this.#emit({
        type: "response.output_item.done",
        response_id: responseId,
        item: {
          type: "function_call",
          call_id: invocationId,
          name: toolName,
          arguments: JSON.stringify(parameters ?? {}),
        },
      });
    });
  }
}

export function createUltravoxTransport(
  options: UltravoxTransportOptions = {},
): RealtimeTransport {
  return new UltravoxRealtimeTransport(options);
}
