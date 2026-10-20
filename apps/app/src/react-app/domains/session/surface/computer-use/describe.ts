// Plain-words helpers for computer use: what an action does, where its
// points land on a displayed frame, and which chat a request belongs to.

export type ComputerUsePoint = { x: number; y: number };

const MODIFIER_LABELS: Record<string, string> = { ctrl: "Ctrl", shift: "Shift", alt: "Alt", meta: "Meta" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function modifiersOf(action: Record<string, unknown>): string[] {
  const value = action.modifiers;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (typeof item === "string" ? [MODIFIER_LABELS[item.toLowerCase()] ?? item] : []));
}

function keyLabel(key: string): string {
  return key.length === 1 ? key.toUpperCase() : key;
}

/** "Ctrl+V", "Enter", "Shift+Tab". */
export function describeKeyChord(action: Record<string, unknown>): string {
  const key = typeof action.key === "string" ? keyLabel(action.key) : "";
  return [...modifiersOf(action), key].filter(Boolean).join("+");
}

/** The text a `type` action types, shown in full; null for other actions. */
export function typedText(action: unknown): string | null {
  return isRecord(action) && action.type === "type" && typeof action.text === "string" ? action.text : null;
}

/**
 * One action in plain words: "Click at 120, 48", "Drag from 10, 10 to 200, 40",
 * "Scroll down 3 steps at 400, 300", "Type \"hello\"", "Press Ctrl+V", "Wait 500 ms".
 */
export function describeComputerUseAction(action: unknown): string {
  if (!isRecord(action) || typeof action.type !== "string") return "Do an action";
  const x = numberValue(action.x);
  const y = numberValue(action.y);
  const at = x !== null && y !== null ? ` at ${Math.round(x)}, ${Math.round(y)}` : "";
  const held = modifiersOf(action);
  const withKeys = held.length ? ` holding ${held.join("+")}` : "";
  switch (action.type) {
    case "click":
      return `Click${at}${withKeys}`;
    case "double_click":
      return `Double click${at}${withKeys}`;
    case "right_click":
      return `Right click${at}${withKeys}`;
    case "move":
      return `Move the pointer${at}`;
    case "drag": {
      const path = pointsOf(action);
      const first = path[0];
      const last = path.at(-1);
      if (!first || !last) return `Drag${withKeys}`;
      return `Drag from ${Math.round(first.x)}, ${Math.round(first.y)} to ${Math.round(last.x)}, ${Math.round(last.y)}${withKeys}`;
    }
    case "scroll": {
      const delta = numberValue(action.delta) ?? 0;
      const horizontal = action.axis === "horizontal";
      const direction = horizontal ? (delta < 0 ? "left" : "right") : delta < 0 ? "up" : "down";
      const steps = Math.abs(delta);
      return `Scroll ${direction} ${steps} ${steps === 1 ? "step" : "steps"}${at}`;
    }
    case "type":
      return `Type "${typeof action.text === "string" ? action.text : ""}"`;
    case "key":
      return `Press ${describeKeyChord(action)}`;
    case "wait": {
      const ms = numberValue(action.ms);
      return ms === null ? "Wait" : `Wait ${Math.round(ms)} ms`;
    }
    default:
      return "Do an action";
  }
}

/** The points of an action (a drag's path, or its x, y), in frame pixels. */
export function pointsOf(action: Record<string, unknown>): ComputerUsePoint[] {
  if (Array.isArray(action.path)) {
    return action.path.flatMap((point) => {
      if (!isRecord(point)) return [];
      const x = numberValue(point.x);
      const y = numberValue(point.y);
      return x === null || y === null ? [] : [{ x, y }];
    });
  }
  const x = numberValue(action.x);
  const y = numberValue(action.y);
  return x === null || y === null ? [] : [{ x, y }];
}

/** Maps points from frame pixels to the displayed size of the frame image. */
export function scalePoints(
  points: ComputerUsePoint[],
  frame: { width: number; height: number },
  shown: { width: number; height: number },
): ComputerUsePoint[] {
  if (frame.width <= 0 || frame.height <= 0) return [];
  const sx = shown.width / frame.width;
  const sy = shown.height / frame.height;
  return points.map((point) => ({ x: point.x * sx, y: point.y * sy }));
}

/** A request or session shows in a chat when it has no chat or that chat. */
export function belongsToChat(chat: string | null, sessionId: string): boolean {
  return chat === null || chat === sessionId;
}

/** "3 min", "less than a minute". */
export function formatMinutesLeft(seconds: number): string {
  if (seconds < 60) return "less than a minute";
  return `${Math.floor(seconds / 60)} min`;
}
