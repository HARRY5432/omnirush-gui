/// <reference lib="webworker" />
/** The git gutter's diff, off the main thread (line-diff.ts). */
import { gutterMarks } from "./line-diff";

self.onmessage = (event: MessageEvent<{ id: number; head: string; current: string }>) => {
  const { id, head, current } = event.data;
  self.postMessage({ id, marks: gutterMarks(head, current) });
};
