/**
 * Abstract base class for ticket connectors.
 *
 * Provides default implementations of `transitionToInProgress` and
 * `transitionToInReview` so concrete connectors do not need to repeat
 * the same one-liner delegation.  Subclasses must:
 *   1. Expose the two status IDs as protected readonly members.
 *   2. Implement `transitionStatus` (and all other `TicketConnector` methods).
 *   3. Declare `implements TicketConnector` themselves so the TypeScript
 *      compiler validates the full contract on each concrete class.
 */
import type { TicketId } from "../interfaces.js";

export abstract class AbstractTicketConnector {
  /** Status ID that maps to the "in-progress" workflow state. */
  protected abstract readonly inProgressStatusId: number;
  /** Status ID that maps to the "in-review" workflow state. */
  protected abstract readonly inReviewStatusId: number;

  /** Move the ticket to an arbitrary target status. Must be implemented by subclasses. */
  abstract transitionStatus(ticketId: TicketId, targetStatusId: number): Promise<void>;

  /** Transition the ticket to the in-progress workflow state. */
  async transitionToInProgress(ticketId: TicketId): Promise<void> {
    await this.transitionStatus(ticketId, this.inProgressStatusId);
  }

  /** Transition the ticket to the in-review workflow state. */
  async transitionToInReview(ticketId: TicketId): Promise<void> {
    await this.transitionStatus(ticketId, this.inReviewStatusId);
  }
}
