import { randomUUID } from "node:crypto";
import { toErrorMessage } from "../errors.js";

export type WriterTaskStatus = "pending" | "running" | "done" | "failed";

export interface WriterTaskSnapshot {
  id: string;
  type: string;
  status: WriterTaskStatus;
  error?: string;
}

export interface WriterQueueSnapshot {
  pending: number;
  running: WriterTaskSnapshot | null;
  recent: WriterTaskSnapshot[];
}

interface InternalTask<T> {
  id: string;
  type: string;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  snapshot: WriterTaskSnapshot;
}

export class WriterQueue {
  private readonly queue: Array<InternalTask<unknown>> = [];
  private readonly recent: WriterTaskSnapshot[] = [];
  private running: InternalTask<unknown> | null = null;

  enqueue<T>(type: string, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: InternalTask<T> = {
        id: randomUUID(),
        type,
        run,
        resolve,
        reject,
        snapshot: {
          id: randomUUID(),
          type,
          status: "pending",
        },
      };

      task.snapshot.id = task.id;
      this.queue.push(task as InternalTask<unknown>);
      void this.drain();
    });
  }

  snapshot(): WriterQueueSnapshot {
    return {
      pending: this.queue.length,
      running: this.running?.snapshot ?? null,
      recent: [...this.recent],
    };
  }

  async waitForIdle(): Promise<void> {
    while (this.running || this.queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private async drain(): Promise<void> {
    if (this.running) {
      return;
    }

    const next = this.queue.shift();
    if (!next) {
      return;
    }

    this.running = next;
    next.snapshot.status = "running";

    try {
      const result = await next.run();
      next.snapshot.status = "done";
      next.resolve(result);
    } catch (error) {
      next.snapshot.status = "failed";
      next.snapshot.error = toErrorMessage(error);
      next.reject(error);
    } finally {
      this.recent.unshift({ ...next.snapshot });
      this.recent.splice(20);
      this.running = null;
      void this.drain();
    }
  }
}
