
export interface OutboxEventPayload {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: Readonly<Record<string, unknown>>;
}

export interface EnqueueOutboxProps {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: OutboxEventPayload;
  occurredAt: Date;
}

export interface OutboxMessageState extends EnqueueOutboxProps {
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class InvalidOutboxStateError extends Error {}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(props: EnqueueOutboxProps): OutboxMessage {
    return new OutboxMessage(
      props.id,
      props.aggregateId,
      props.eventType,
      props.payload as unknown as Readonly<Record<string, unknown>>,
      props.occurredAt,
      0,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload as unknown as Readonly<Record<string, unknown>>,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number { return this._attempts; }
  get nextAttemptAt(): Date | undefined { return this._nextAttemptAt; }
  get publishedAt(): Date | undefined { return this._publishedAt; }

  isPending(): boolean { return this._publishedAt === undefined; }

  isDue(now: Date): boolean {
    if (!this.isPending()) return false;
    return !this._nextAttemptAt || this._nextAttemptAt <= now;
  }

  markPublished(at: Date): void {
    if (this._publishedAt) throw new InvalidOutboxStateError('already published');
    this._publishedAt = at;
  }

  scheduleRetry(now: Date): void {
    if (this._publishedAt) throw new InvalidOutboxStateError('already published');
    this._attempts += 1;
    const backoffMs = Math.min(2 ** this._attempts * 1000, 60_000);
    this._nextAttemptAt = new Date(now.getTime() + backoffMs);
  }
}