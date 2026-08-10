/** Normalise an abort reason (or any thrown value) into an Error. */
export function toRejectionError(reason: unknown, fallback?: Error): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason.trim().length > 0) return new Error(reason);
  if (reason === undefined || reason === null) return fallback ?? new Error("Operation aborted");
  return fallback ?? new Error("Operation aborted");
}
