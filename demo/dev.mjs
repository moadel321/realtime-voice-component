import { spawn } from "node:child_process";
import process from "node:process";
import util from "node:util";
import { existsSync, readFileSync } from "node:fs";

const children = [];
let shuttingDown = false;

function spawnProcess(command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      ...extraEnv,
    },
  });

  children.push(child);

  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    for (const other of children) {
      if (other !== child && !other.killed) {
        other.kill("SIGTERM");
      }
    }

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });

  return child;
}

function parseEnvContent(content) {
  if (typeof util.parseEnv === "function") {
    return util.parseEnv(content);
  }

  return Object.fromEntries(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separatorIndex = line.indexOf("=");
        if (separatorIndex < 1) {
          return null;
        }

        const key = line.slice(0, separatorIndex).trim();
        const rawValue = line.slice(separatorIndex + 1).trim();
        const value =
          (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
          (rawValue.startsWith("'") && rawValue.endsWith("'"))
            ? rawValue.slice(1, -1)
            : rawValue;

        return [key, value];
      })
      .filter(Boolean),
  );
}

function loadLocalEnv(path) {
  if (!existsSync(path)) {
    return;
  }

  const entries = parseEnvContent(readFileSync(path, "utf8"));
  for (const [key, value] of Object.entries(entries)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function getViteRunnerArgs() {
  // Spawn Vite directly through Node. Going through `npm`/`pnpm`/`corepack` on
  // Windows routes through cmd.exe and the parent loses the child's stdio,
  // making the orchestrator look like it exited immediately.
  return {
    command: process.execPath,
    args: ["node_modules/vite/bin/vite.js", "--config", "demo/vite.config.ts"],
  };
}

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

loadLocalEnv("demo/.env.local");
const viteRunner = getViteRunnerArgs();

spawnProcess(process.execPath, ["demo/session-server.mjs"]);
spawnProcess(process.execPath, ["demo/ultravox-call-server.mjs"]);
spawnProcess(viteRunner.command, viteRunner.args, {
  DEMO_SESSION_ORIGIN:
    process.env.DEMO_SESSION_ORIGIN ?? process.env.DEMO_TOKEN_ORIGIN ?? "http://localhost:3211",
  DEMO_ULTRAVOX_ORIGIN: process.env.DEMO_ULTRAVOX_ORIGIN ?? "http://localhost:3212",
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
