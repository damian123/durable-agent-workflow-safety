import type {
  ActionRecord,
  DurableSnapshot,
  ProgressEvent,
} from "./types.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryDurableStore {
  private readonly actions = new Map<string, ActionRecord>();
  private readonly progress: ProgressEvent[] = [];

  constructor(snapshot?: DurableSnapshot) {
    if (snapshot === undefined) return;
    for (const action of snapshot.actions) {
      this.actions.set(action.actionId, clone(action));
    }
    this.progress.push(...snapshot.events.map((event) => clone(event)));
  }

  getAction(actionId: string): ActionRecord | undefined {
    const action = this.actions.get(actionId);
    return action === undefined ? undefined : clone(action);
  }

  saveAction(action: ActionRecord): void {
    this.actions.set(action.actionId, clone(action));
  }

  appendEvent(event: Omit<ProgressEvent, "ordinal">): ProgressEvent {
    const stored: ProgressEvent = {
      ...event,
      ordinal: this.progress.length + 1,
    };
    this.progress.push(stored);
    return clone(stored);
  }

  events(actionId?: string): readonly ProgressEvent[] {
    const selected =
      actionId === undefined
        ? this.progress
        : this.progress.filter((event) => event.actionId === actionId);
    return selected.map((event) => clone(event));
  }

  snapshot(): DurableSnapshot {
    return {
      actions: [...this.actions.values()].map((action) => clone(action)),
      events: this.progress.map((event) => clone(event)),
    };
  }
}
