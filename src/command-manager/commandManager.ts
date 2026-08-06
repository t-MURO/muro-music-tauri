export type Command = {
  do: () => string | void | Promise<string | void>;
  undo: () => string | void | Promise<string | void>;
  label?: string;
  timestamp?: number;
};

export type HistoryState = {
  canUndo: boolean;
  canRedo: boolean;
  isBusy: boolean;
  undoLabel?: string;
  redoLabel?: string;
};

// Every entry holds closures over track snapshots, so an unbounded stack keeps
// deleted tracks alive for the whole session. Old entries are dropped instead.
const MAX_HISTORY = 50;

export class CommandManager {
  private past: Command[] = [];
  private future: Command[] = [];
  private listeners = new Set<(state: HistoryState) => void>();
  private operationQueue: Promise<void> = Promise.resolve();
  private queuedOperations = 0;

  private notify() {
    const state = this.state;
    for (const listener of this.listeners) listener(state);
  }

  subscribe(listener: (state: HistoryState) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get state(): HistoryState {
    const isBusy = this.queuedOperations > 0;
    return {
      canUndo: this.past.length > 0 && !isBusy,
      canRedo: this.future.length > 0 && !isBusy,
      isBusy,
      undoLabel: this.past[this.past.length - 1]?.label,
      redoLabel: this.future[this.future.length - 1]?.label,
    };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.queuedOperations += 1;
    this.notify();
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.then(() => undefined, () => undefined);
    return next.finally(() => {
      this.queuedOperations -= 1;
      this.notify();
    });
  }

  execute(command: Command): Promise<void> {
    return this.enqueue(async () => {
      const stamped = { ...command, timestamp: Date.now() };
      await stamped.do();
      this.past.push(stamped);
      if (this.past.length > MAX_HISTORY) this.past.shift();
      this.future = [];
      this.notify();
    });
  }

  /**
   * Adds a command whose initial effect has already completed. This is used by
   * workflows such as file import, where the backend must finish before the
   * renderer knows which concrete records an inverse would remove.
   */
  recordExecuted(command: Command): Promise<void> {
    return this.enqueue(async () => {
      const stamped = { ...command, timestamp: Date.now() };
      this.past.push(stamped);
      if (this.past.length > MAX_HISTORY) this.past.shift();
      this.future = [];
      this.notify();
    });
  }

  /** Returns what the persisted inverse actually did so callers can report it. */
  undo(): Promise<string | undefined> {
    return this.enqueue(async () => {
      const command = this.past[this.past.length - 1];
      if (!command) return undefined;

      const outcome = await command.undo();
      this.past.pop();
      this.future.push(command);
      if (this.future.length > MAX_HISTORY) this.future.shift();
      this.notify();
      return outcome ?? (command.label ? `Undid: ${command.label}` : "Undone");
    });
  }

  /** Returns what the persisted command actually did so callers can report it. */
  redo(): Promise<string | undefined> {
    return this.enqueue(async () => {
      const command = this.future[this.future.length - 1];
      if (!command) return undefined;

      const outcome = await command.do();
      this.future.pop();
      this.past.push(command);
      if (this.past.length > MAX_HISTORY) this.past.shift();
      this.notify();
      return outcome ?? (command.label ? `Redid: ${command.label}` : "Redone");
    });
  }

  clear() {
    this.past = [];
    this.future = [];
    this.notify();
  }

  get canUndo() {
    return this.past.length > 0 && this.queuedOperations === 0;
  }

  get canRedo() {
    return this.future.length > 0 && this.queuedOperations === 0;
  }
}

export const commandManager = new CommandManager();
