/**
 * Human-readable text for a caught value.
 *
 * Kept separate so the marker writer and the boot policy can share it without
 * importing each other, and so `String` on a hostile object cannot throw while
 * a crash or a failed write is being reported.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;

  try {
    return String(error);
  } catch {
    return "unprintable error";
  }
}
