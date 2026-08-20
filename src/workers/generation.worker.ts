/**
 * Generation worker: runs engine jobs off the main thread with progress.
 */

import { runBreed, runGenerate, runMorph, runSearch, type BreedJob, type GenerateJob, type MorphJob, type SearchJob } from "../engine/jobs";

interface JobMessage {
  id: number;
  cmd: "generate" | "search" | "morph" | "breed";
  payload: unknown;
}

interface OutMessage {
  id: number;
  type: "progress" | "result" | "error";
  done?: number;
  total?: number;
  payload?: unknown;
  error?: string;
}

const ctx = self as unknown as Worker;

ctx.onmessage = (ev: MessageEvent<JobMessage>) => {
  const { id, cmd, payload } = ev.data;
  const post = (msg: OutMessage, transfer?: Transferable[]) => ctx.postMessage(msg, transfer ?? []);
  const onProgress = (done: number, total: number) => post({ id, type: "progress", done, total });
  try {
    let result: unknown;
    if (cmd === "generate") {
      result = runGenerate({ ...(payload as GenerateJob), onProgress });
    } else if (cmd === "search") {
      result = runSearch({ ...(payload as SearchJob), onProgress });
    } else if (cmd === "morph") {
      result = runMorph(payload as MorphJob);
    } else if (cmd === "breed") {
      result = runBreed(payload as BreedJob);
    }
    post({ id, type: "result", payload: result });
  } catch (e) {
    post({ id, type: "error", error: e instanceof Error ? e.message : String(e) });
  }
};
