import { describe, it, expect } from "vitest";
import {
  shouldSkipReviewPosting,
  selectRepliesToPost,
  type EligibleThreadEntry,
} from "../../src/review/reviewPostingGate.js";
import type { ThreadReply } from "../../src/interfaces.js";

describe("shouldSkipReviewPosting", () => {
  const base = {
    force: false,
    cycleNumber: 2,
    hasNothingNew: true,
    previousDecision: 1 as -1 | 0 | 1,
    decision: 1 as -1 | 0 | 1,
  };

  it("skips when nothing new and the verdict matches the prior cycle", () => {
    expect(shouldSkipReviewPosting(base)).toBe(true);
  });

  it("does not skip a forced re-review even when nothing is new and the verdict is unchanged", () => {
    expect(shouldSkipReviewPosting({ ...base, force: true })).toBe(false);
  });

  it("does not skip the first cycle", () => {
    expect(shouldSkipReviewPosting({ ...base, cycleNumber: 1 })).toBe(false);
  });

  it("does not skip when there is something new to say", () => {
    expect(shouldSkipReviewPosting({ ...base, hasNothingNew: false })).toBe(false);
  });

  it("does not skip when there is no prior decision recorded", () => {
    expect(shouldSkipReviewPosting({ ...base, previousDecision: null })).toBe(false);
  });

  it("does not skip when the verdict changed from the prior cycle", () => {
    expect(shouldSkipReviewPosting({ ...base, previousDecision: -1, decision: 1 })).toBe(false);
  });
});

describe("selectRepliesToPost", () => {
  function makeThreadMap(entries: Record<string, EligibleThreadEntry>): Map<string, EligibleThreadEntry> {
    return new Map(Object.entries(entries));
  }

  it("drops replies to hallucinated (unknown) thread ids", () => {
    const replies: ThreadReply[] = [{ threadId: "unknown", message: "hi" }];
    const result = selectRepliesToPost(replies, makeThreadMap({}), 20);
    expect(result).toEqual([]);
  });

  it("drops duplicate replies to the same thread id, keeping the first", () => {
    const replies: ThreadReply[] = [
      { threadId: "t1", message: "first" },
      { threadId: "t1", message: "second" },
    ];
    const result = selectRepliesToPost(replies, makeThreadMap({ t1: { handledHash: "h1" } }), 20);
    expect(result).toEqual([{ threadId: "t1", message: "first", handledHash: "h1" }]);
  });

  it("drops replies with an empty (whitespace-only) body", () => {
    const replies: ThreadReply[] = [{ threadId: "t1", message: "   " }];
    const result = selectRepliesToPost(replies, makeThreadMap({ t1: { handledHash: "h1" } }), 20);
    expect(result).toEqual([]);
  });

  it("caps the number of replies at maxReplies", () => {
    const replies: ThreadReply[] = [
      { threadId: "t1", message: "a" },
      { threadId: "t2", message: "b" },
      { threadId: "t3", message: "c" },
    ];
    const threadMap = makeThreadMap({
      t1: { handledHash: "h1" },
      t2: { handledHash: "h2" },
      t3: { handledHash: "h3" },
    });
    const result = selectRepliesToPost(replies, threadMap, 2);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.threadId)).toEqual(["t1", "t2"]);
  });

  it("trims message whitespace and attaches the thread's handled hash", () => {
    const replies: ThreadReply[] = [{ threadId: "t1", message: "  trimmed  " }];
    const result = selectRepliesToPost(replies, makeThreadMap({ t1: { handledHash: "h1" } }), 20);
    expect(result).toEqual([{ threadId: "t1", message: "trimmed", handledHash: "h1" }]);
  });
});
