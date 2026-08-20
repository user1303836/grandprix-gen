/**
 * Worker client: promise-based job dispatch with progress callbacks.
 */

type Cmd = "generate" | "search" | "morph" | "breed" | "scout" | "lockregen";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (done: number, total: number) => void;
}

export class EngineClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker = new Worker(new URL("../workers/generation.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (ev: MessageEvent) => {
      const { id, type, done, total, payload, error } = ev.data;
      const p = this.pending.get(id);
      if (!p) return;
      if (type === "progress") {
        p.onProgress?.(done, total);
      } else if (type === "result") {
        this.pending.delete(id);
        p.resolve(payload);
      } else if (type === "error") {
        this.pending.delete(id);
        p.reject(new Error(error));
      }
    };
  }

  run<T>(cmd: Cmd, payload: unknown, onProgress?: (done: number, total: number) => void): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      this.worker.postMessage({ id, cmd, payload });
    });
  }
}
