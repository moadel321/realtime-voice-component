# realtime-voice-component

a fork of [openai/realtime-voice-component](https://github.com/openai/realtime-voice-component).

this fork swaps the openai gpt realtime transport for
[ultravox v0.7](https://ultravox.ai) as an experiment to lower cost. the
controller, tools, and react api work the same — you just point it at a
different transport.

the ultravox transport lives in `src/transport/ultravoxRealtimeTransport.ts`,
with a matching demo proxy in `demo/ultravox-call-server.mjs`. set
`VITE_VOICE_PROVIDER=ultravox` in `demo/.env.local` to run the demo against it.

for install, api, and everything else, see the
[upstream readme](https://github.com/openai/realtime-voice-component#readme).
