export type TransportError = Error & {
  code?: string;
};

export function createTransportError(
  message: string,
  options?: {
    code?: string;
    name?: string;
  },
) {
  const error = new Error(message) as TransportError;

  if (options?.code) {
    error.code = options.code;
  }

  if (options?.name) {
    error.name = options.name;
  }

  return error;
}

export function createAbortError() {
  return createTransportError("Voice control connection was cancelled.", {
    code: "aborted",
    name: "AbortError",
  });
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}
