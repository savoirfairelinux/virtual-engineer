import { describe, it, expect, vi } from "vitest";
import { AbstractTicketConnector } from "../../src/connectors/baseTicketConnector.js";
import { makeTicketId } from "../../src/interfaces.js";
import type {
  AssignedTicketQueryOptions,
  Ticket,
  TicketConnector,
  TicketId,
} from "../../src/interfaces.js";

// ─── Minimal concrete stub ─────────────────────────────────────────────────────

class StubTicketConnector extends AbstractTicketConnector implements TicketConnector {
  readonly inProgressStatusId = 2;
  readonly inReviewStatusId = 4;

  transitionStatus = vi.fn(async (_ticketId: TicketId, _targetStatusId: number) => {
    // intentionally empty — spied on in tests
  });

  // ── Unused TicketConnector stubs ──────────────────────────────────────────
  getAssignedTickets(_opts?: AssignedTicketQueryOptions): Promise<Ticket[]> {
    return Promise.resolve([]);
  }
  getTicket(_ticketId: TicketId): Promise<Ticket> {
    return Promise.reject(new Error("not implemented"));
  }
  addNote(_ticketId: TicketId, _note: string): Promise<void> {
    return Promise.resolve();
  }
  closeTicket(_ticketId: TicketId, _closingNote: string): Promise<void> {
    return Promise.resolve();
  }
  getSourceLabel(): string {
    return "stub";
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("AbstractTicketConnector", () => {
  it("transitionToInProgress delegates to transitionStatus with inProgressStatusId", async () => {
    const connector = new StubTicketConnector();
    const ticketId = makeTicketId("42");

    await connector.transitionToInProgress(ticketId);

    expect(connector.transitionStatus).toHaveBeenCalledOnce();
    expect(connector.transitionStatus).toHaveBeenCalledWith(ticketId, 2);
  });

  it("transitionToInReview delegates to transitionStatus with inReviewStatusId", async () => {
    const connector = new StubTicketConnector();
    const ticketId = makeTicketId("99");

    await connector.transitionToInReview(ticketId);

    expect(connector.transitionStatus).toHaveBeenCalledOnce();
    expect(connector.transitionStatus).toHaveBeenCalledWith(ticketId, 4);
  });

  it("forwards transitionStatus errors to callers", async () => {
    const connector = new StubTicketConnector();
    connector.transitionStatus.mockRejectedValueOnce(new Error("network error"));

    await expect(connector.transitionToInProgress(makeTicketId("1"))).rejects.toThrow("network error");
  });

  it("each call passes the correct ticketId through", async () => {
    const connector = new StubTicketConnector();
    const id1 = makeTicketId("101");
    const id2 = makeTicketId("202");

    await connector.transitionToInProgress(id1);
    await connector.transitionToInReview(id2);

    expect(connector.transitionStatus).toHaveBeenNthCalledWith(1, id1, 2);
    expect(connector.transitionStatus).toHaveBeenNthCalledWith(2, id2, 4);
  });
});
