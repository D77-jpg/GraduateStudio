/** Legacy accessors: AI requests have no platform deadline; only caller cancellation applies. */
export function getAiRequestTimeoutMs(
  _source: Record<string, string | undefined> = process.env,
): undefined {
  void _source;
  return undefined;
}

export function getAiGenerationTimeoutMs(): undefined {
  return undefined;
}
