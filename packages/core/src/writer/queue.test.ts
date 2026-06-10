import { describe, expect, it } from "vitest";
import { WriterQueue } from "./queue.js";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe("WriterQueue", () => {
  it("runs tasks serially in FIFO order", async () => {
    const queue = new WriterQueue();
    const order: number[] = [];

    const tasks = [1, 2, 3].map((n) =>
      queue.enqueue(`task-${n}`, async () => {
        await tick(10 - n);
        order.push(n);
        return n;
      }),
    );

    const results = await Promise.all(tasks);
    expect(results).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("propagates task failures and keeps draining", async () => {
    const queue = new WriterQueue();

    await expect(
      queue.enqueue("boom", async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");

    const ok = await queue.enqueue("ok", async () => "done");
    expect(ok).toBe("done");
  });

  it("reports pending and recent snapshots", async () => {
    const queue = new WriterQueue();
    await queue.enqueue("first", async () => "a");
    await queue.enqueue("second", async () => "b");

    const snapshot = queue.snapshot();
    expect(snapshot.running).toBeNull();
    expect(snapshot.pending).toBe(0);
    expect(snapshot.recent[0]?.type).toBe("second");
    expect(snapshot.recent[0]?.status).toBe("done");
  });

  it("records failed status in recent snapshots", async () => {
    const queue = new WriterQueue();
    await queue.enqueue("bad", async () => {
      throw new Error("kaboom");
    }).catch(() => undefined);

    const failed = queue.snapshot().recent[0];
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("kaboom");
  });

  it("waitForIdle resolves after the queue drains", async () => {
    const queue = new WriterQueue();
    let done = false;
    void queue.enqueue("slow", async () => {
      await tick(20);
      done = true;
    });

    await queue.waitForIdle();
    expect(done).toBe(true);
    expect(queue.snapshot().pending).toBe(0);
  });
});
