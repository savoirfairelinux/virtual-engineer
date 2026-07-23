# Async Programming Patterns

Best practices for handling asynchronous operations in TypeScript with type safety.

## Async/Await Fundamentals

### Always specify return types

```typescript
// BAD: Implicit return type
async function fetchUser(id: string) {
  const response = await fetch(`/api/users/${id}`);
  return response.json();
}

// GOOD: Explicit return type
async function fetchUser(id: string): Promise<User> {
  const response = await fetch(`/api/users/${id}`);
  return response.json() as Promise<User>;
}

// BETTER: With Result type for error handling
async function fetchUser(id: string): Promise<Result<User, ApiError>> {
  try {
    const response = await fetch(`/api/users/${id}`);
    if (!response.ok) {
      return err(new ApiError('Failed to fetch user', response.status));
    }
    const data = await response.json();
    return ok(data as User);
  } catch (e) {
    return err(new ApiError('Network error', 0, e));
  }
}
```

## Concurrent Execution

### Promise.all for independent operations

```typescript
// BAD: Sequential execution
async function loadDashboard(userId: string): Promise<Dashboard> {
  const user = await fetchUser(userId);           // Wait
  const orders = await fetchOrders(userId);       // Then wait
  const notifications = await fetchNotifications(); // Then wait
  return { user, orders, notifications };
}

// GOOD: Parallel execution
async function loadDashboard(userId: string): Promise<Dashboard> {
  const [user, orders, notifications] = await Promise.all([
    fetchUser(userId),
    fetchOrders(userId),
    fetchNotifications(),
  ]);
  return { user, orders, notifications };
}
```

### Promise.allSettled for partial failure tolerance

```typescript
async function loadDashboard(userId: string): Promise<Dashboard> {
  const results = await Promise.allSettled([
    fetchUser(userId),
    fetchOrders(userId),
    fetchNotifications(),
  ]);

  const user = results[0].status === 'fulfilled' ? results[0].value : null;
  const orders = results[1].status === 'fulfilled' ? results[1].value : [];
  const notifications = results[2].status === 'fulfilled' ? results[2].value : [];

  return { user, orders, notifications };
}
```

### Type-safe Promise.allSettled helper

```typescript
type SettledResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown };

function extractFulfilled<T>(results: SettledResult<T>[]): T[] {
  return results
    .filter((r): r is { status: 'fulfilled'; value: T } => r.status === 'fulfilled')
    .map((r) => r.value);
}

function extractRejected(results: SettledResult<unknown>[]): unknown[] {
  return results
    .filter((r): r is { status: 'rejected'; reason: unknown } => r.status === 'rejected')
    .map((r) => r.reason);
}
```

## Error Handling in Async Code

### Wrap external APIs at boundaries

```typescript
import { ResultAsync, errAsync, okAsync } from 'neverthrow';

// Wrap fetch at the boundary
function safeFetch<T>(url: string): ResultAsync<T, ApiError> {
  return ResultAsync.fromPromise(
    fetch(url).then(async (response) => {
      if (!response.ok) {
        throw new ApiError(`HTTP ${response.status}`, response.status);
      }
      return response.json() as Promise<T>;
    }),
    (error) => {
      if (error instanceof ApiError) return error;
      return new ApiError('Network error', 0, error);
    }
  );
}

// Use throughout the application
async function getUser(id: string): Promise<Result<User, ApiError>> {
  return safeFetch<User>(`/api/users/${id}`);
}
```

### Avoid unhandled rejections

```typescript
// BAD: Fire and forget
function initApp(): void {
  loadConfig(); // Promise ignored, rejection unhandled
}

// GOOD: Handle at top level
async function initApp(): Promise<void> {
  try {
    await loadConfig();
  } catch (e) {
    console.error('Failed to initialize:', e);
    process.exit(1);
  }
}

// Or with Result type
async function initApp(): Promise<Result<void, InitError>> {
  const configResult = await loadConfig();
  if (!configResult.ok) {
    return err(new InitError('Config failed', configResult.error));
  }
  return ok(undefined);
}
```

## Async Iteration

### For-await-of for async iterables

```typescript
async function* fetchPages<T>(baseUrl: string): AsyncGenerator<T[], void, unknown> {
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await fetch(`${baseUrl}?page=${page}`);
    const data = await response.json();
    yield data.items as T[];
    hasMore = data.hasNext;
    page++;
  }
}

// Usage
async function getAllUsers(): Promise<User[]> {
  const users: User[] = [];
  for await (const page of fetchPages<User>('/api/users')) {
    users.push(...page);
  }
  return users;
}
```

### Process in batches

```typescript
async function processBatch<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  batchSize: number
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
  }

  return results;
}

// Usage
const processed = await processBatch(users, updateUser, 10);
```

## Timeouts and Cancellation

### AbortController for cancellation

```typescript
async function fetchWithTimeout<T>(
  url: string,
  timeoutMs: number
): Promise<Result<T, TimeoutError | ApiError>> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      return err(new ApiError(`HTTP ${response.status}`));
    }
    return ok(await response.json() as T);
  } catch (e) {
    clearTimeout(timeoutId);
    if (e instanceof Error && e.name === 'AbortError') {
      return err(new TimeoutError(`Request timed out after ${timeoutMs}ms`));
    }
    return err(new ApiError('Request failed', e));
  }
}
```

### Retry with exponential backoff

```typescript
interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions
): Promise<Result<T, Error>> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      const result = await operation();
      return ok(result);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));

      if (attempt < options.maxAttempts) {
        const delay = Math.min(
          options.baseDelayMs * Math.pow(2, attempt - 1),
          options.maxDelayMs
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  return err(lastError ?? new Error('All retry attempts failed'));
}

// Usage
const result = await withRetry(
  () => fetch('/api/data').then((r) => r.json()),
  { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10000 }
);
```

## Anti-Patterns to Avoid

```typescript
// BAD: await in loop for independent operations
async function processUsers(ids: string[]): Promise<User[]> {
  const users: User[] = [];
  for (const id of ids) {
    const user = await fetchUser(id); // Sequential!
    users.push(user);
  }
  return users;
}

// GOOD: Parallel execution
async function processUsers(ids: string[]): Promise<User[]> {
  return Promise.all(ids.map(fetchUser));
}

// BAD: Mixing callbacks and promises
function loadData(callback: (data: Data) => void): void {
  fetchData().then(callback); // Loses error handling
}

// GOOD: Consistent async pattern
async function loadData(): Promise<Data> {
  return fetchData();
}

// BAD: Swallowing errors
async function riskyOperation(): Promise<void> {
  try {
    await dangerousThing();
  } catch {
    // Silent failure
  }
}

// GOOD: Always handle or propagate
async function riskyOperation(): Promise<Result<void, Error>> {
  try {
    await dangerousThing();
    return ok(undefined);
  } catch (e) {
    logger.error('Operation failed', e);
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

// BAD: Creating promise but not awaiting
function saveAll(items: Item[]): void {
  items.forEach(async (item) => {
    await save(item); // Promise not tracked!
  });
}

// GOOD: Track all promises
async function saveAll(items: Item[]): Promise<void> {
  await Promise.all(items.map(save));
}
```

## References

- [Async/Await in TypeScript](https://blog.logrocket.com/async-await-typescript/)
- [Async/Await Pattern in TypeScript](https://softwarepatternslexicon.com/patterns-ts/8/2/)
- [Best Practices for Error Handling in Await](https://www.dhiwise.com/post/best-practices-for-error-handling-in-await-expression)
