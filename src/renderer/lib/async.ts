export type IpcResult<T> = { ok: true; value: T } | { ok: false };

function messageFor(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message.trim()) return fallback;
  return `${fallback} ${error.message}`;
}

/** Runs an IPC transition without allowing its pending UI to become permanent. */
export async function runIpc<T>(
  task: () => Promise<T>,
  options: {
    setPending?: (pending: boolean) => void;
    setError: (message: string | null) => void;
    fallback: string;
  },
): Promise<IpcResult<T>> {
  options.setPending?.(true);
  options.setError(null);
  try {
    return { ok: true, value: await task() };
  } catch (error) {
    options.setError(messageFor(error, options.fallback));
    return { ok: false };
  } finally {
    options.setPending?.(false);
  }
}
