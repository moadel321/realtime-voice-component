import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import {
  createUltravoxTransport,
  createVoiceControlController,
  useVoiceControl,
  type UseVoiceControlOptions,
  type VoiceControlController,
} from "realtime-voice-component";

type VoiceProvider = "openai" | "ultravox";

const ENV_PROVIDER = String(import.meta.env.VITE_VOICE_PROVIDER ?? "openai")
  .trim()
  .toLowerCase();
const VOICE_PROVIDER: VoiceProvider = ENV_PROVIDER === "ultravox" ? "ultravox" : "openai";

if (typeof window !== "undefined") {
  // Surface the resolved provider in the dev console so misconfigured env vars
  // are obvious. Hot module replacement re-evaluates this module on edit.
  // eslint-disable-next-line no-console
  console.info(`[demo] voice provider = ${VOICE_PROVIDER} (raw env: ${JSON.stringify(import.meta.env.VITE_VOICE_PROVIDER)})`);
}

const STATE_UPDATE_INSTRUCTION =
  VOICE_PROVIDER === "ultravox"
    ? " The host app sends authoritative state observations as deferred messages prefixed with [State update]. Treat them as ground truth about the current UI."
    : "";

type DemoSessionContextValue = {
  activeDemoIdRef: { current: string | null };
  controller: VoiceControlController;
};

type SharedDemoControllerBaseOptions = Pick<
  UseVoiceControlOptions,
  "instructions" | "postToolResponse" | "tools"
>;

type SharedDemoControllerOptions = SharedDemoControllerBaseOptions & {
  demoId: string;
};

const DemoSessionContext = createContext<DemoSessionContextValue | null>(null);

const PROVIDER_OPTIONS = {
  openai: {
    auth: { sessionEndpoint: "/session" },
    model: "gpt-realtime-1.5",
  },
  ultravox: {
    auth: { sessionEndpoint: "/ultravox/call" },
    model: "ultravox-v0.7",
    transportFactory: () => createUltravoxTransport({ callEndpoint: "/ultravox/call" }),
  },
} as const satisfies Record<VoiceProvider, Partial<UseVoiceControlOptions>>;

function buildBaseControllerOptions(
  options: SharedDemoControllerBaseOptions,
): UseVoiceControlOptions {
  const instructions =
    options.instructions !== undefined
      ? options.instructions + STATE_UPDATE_INSTRUCTION
      : undefined;

  return {
    activationMode: "vad",
    outputMode: "text+audio",
    ...PROVIDER_OPTIONS[VOICE_PROVIDER],
    ...(instructions !== undefined ? { instructions } : {}),
    ...(options.postToolResponse !== undefined
      ? { postToolResponse: options.postToolResponse }
      : {}),
    tools: options.tools,
  };
}

export function DemoSessionProvider({ children }: PropsWithChildren) {
  const [controller] = useState(() =>
    createVoiceControlController(
      buildBaseControllerOptions({
        instructions: "Demo session is initializing.",
        postToolResponse: false,
        tools: [],
      }),
    ),
  );
  const [activeDemoIdRef] = useState<{ current: string | null }>(() => ({
    current: null,
  }));

  useEffect(() => {
    return () => controller.destroy();
  }, [controller]);

  const value = useMemo(
    () => ({
      activeDemoIdRef,
      controller,
    }),
    [activeDemoIdRef, controller],
  );

  return <DemoSessionContext.Provider value={value}>{children}</DemoSessionContext.Provider>;
}

export function useSharedDemoController(options: SharedDemoControllerOptions) {
  const context = useContext(DemoSessionContext);

  if (!context) {
    throw new Error("useSharedDemoController must be used inside DemoSessionProvider.");
  }

  const runtime = useVoiceControl(context.controller);

  useEffect(() => {
    const nextOptions = buildBaseControllerOptions(options);
    const previousDemoId = context.activeDemoIdRef.current;
    const demoChanged = previousDemoId !== null && previousDemoId !== options.demoId;
    const shouldReconnect =
      context.controller.connected || context.controller.activity === "connecting";

    context.activeDemoIdRef.current = options.demoId;

    if (demoChanged) {
      context.controller.disconnect();
      context.controller.clearToolCalls();
    }

    context.controller.configure(nextOptions);

    if (demoChanged && shouldReconnect) {
      void context.controller.connect();
    }
  }, [
    context.controller,
    options.demoId,
    options.instructions,
    options.postToolResponse,
    options.tools,
  ]);

  return {
    controller: context.controller,
    runtime,
  };
}

export function useOverviewDemoSession() {
  const context = useContext(DemoSessionContext);

  if (!context) {
    throw new Error("useOverviewDemoSession must be used inside DemoSessionProvider.");
  }

  useEffect(() => {
    const previousDemoId = context.activeDemoIdRef.current;
    const demoChanged = previousDemoId !== null && previousDemoId !== "overview";

    context.activeDemoIdRef.current = "overview";

    if (demoChanged) {
      context.controller.disconnect();
      context.controller.clearToolCalls();
    }

    context.controller.configure(
      buildBaseControllerOptions({
        instructions: "Overview page is active.",
        postToolResponse: false,
        tools: [],
      }),
    );
  }, [context.activeDemoIdRef, context.controller]);
}
