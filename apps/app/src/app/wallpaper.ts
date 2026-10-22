/**
 * Wallpaper picture for Settings > Appearance: kept on this device in IndexedDB
 * (too big for localStorage) and shown through a blob: URL in a CSS variable.
 */
import { getAppearancePrefs, setAppearancePrefs } from "./theme";

const DB_NAME = "omnirush-appearance";
const STORE = "files";
const KEY = "wallpaper";
const IMAGE_VAR = "--omnirush-wallpaper-image";

export const WALLPAPER_TYPES = ["image/png", "image/jpeg", "image/webp", "image/avif", "image/gif"] as const;
export const MAX_WALLPAPER_BYTES = 8 * 1024 * 1024;

let currentUrl: string | null = null;

/** Null when the file can be used, else a sentence for the user. */
export function checkWallpaperFile(file: { type: string; size: number }): string | null {
  if (!(WALLPAPER_TYPES as readonly string[]).includes(file.type)) return "Choose a PNG, JPEG, WebP, AVIF or GIF image.";
  if (file.size <= 0) return "That file is empty.";
  if (file.size > MAX_WALLPAPER_BYTES) return "Choose an image under 8 MB.";
  return null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = action(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

function showImage(blob: Blob | null) {
  if (typeof document === "undefined") return;
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = blob ? URL.createObjectURL(blob) : null;
  const style = document.documentElement.style;
  if (currentUrl) style.setProperty(IMAGE_VAR, `url("${currentUrl}")`);
  else style.removeProperty(IMAGE_VAR);
}

/** Checks, decodes and stores the picture, then turns the wallpaper on. Throws a readable Error. */
export async function setWallpaperFromFile(file: File): Promise<void> {
  const problem = checkWallpaperFile(file);
  if (problem) throw new Error(problem);
  try {
    // Decoding proves it is a real picture, not just a file with an image name.
    (await createImageBitmap(file)).close();
  } catch {
    throw new Error("That image could not be opened.");
  }
  await run("readwrite", (store) => store.put(file, KEY));
  showImage(file);
  setAppearancePrefs({ wallpaper: true });
}

export async function removeWallpaper(): Promise<void> {
  setAppearancePrefs({ wallpaper: false });
  showImage(null);
  await run("readwrite", (store) => store.delete(KEY)).catch(() => undefined);
}

/** At start: shows the saved picture, or turns the wallpaper off if the picture is gone. */
export async function restoreWallpaper(): Promise<void> {
  if (!getAppearancePrefs().wallpaper || typeof indexedDB === "undefined") return;
  const blob = await run<unknown>("readonly", (store) => store.get(KEY)).catch(() => null);
  if (blob instanceof Blob) showImage(blob);
  else setAppearancePrefs({ wallpaper: false });
}
