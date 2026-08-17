/** Persisted "has this one-time product tour already been shown" flags. */
const PREFIX = "ve-tour-";

export function hasSeenTour(key: string): boolean {
  try {
    return localStorage.getItem(PREFIX + key) === "1";
  } catch {
    return false;
  }
}

export function markTourSeen(key: string): void {
  try {
    localStorage.setItem(PREFIX + key, "1");
  } catch { /* ignore (private mode / storage disabled) */ }
}
