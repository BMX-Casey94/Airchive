export function identityRegistryUnavailable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /fetch failed|timed out|timeout|ENOTFOUND|ECONNRESET|ECONNREFUSED|network/i.test(message);
}
