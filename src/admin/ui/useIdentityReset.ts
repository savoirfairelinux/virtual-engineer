export function applyIfCurrentGeneration<T>(
  value: T,
  requestGeneration: number,
  currentGeneration: number,
  apply: (value: T) => void,
): void {
  if (requestGeneration === currentGeneration) apply(value);
}
