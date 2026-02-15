export function log(event: string, data: Record<string, unknown> = {}): void {
  const payload = {
    ts: new Date().toISOString(),
    event,
    ...data
  };
  console.log(JSON.stringify(payload));
}

export function logError(event: string, error: unknown, data: Record<string, unknown> = {}): void {
  const message = error instanceof Error ? error.message : String(error);
  log(event, { ...data, error: message });
}
