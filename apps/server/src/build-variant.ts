/**
 * Which build of the app this is, fixed when it is built; nothing at runtime
 * (environment, settings) changes it.
 *
 * The source and `pnpm build` output are the dev variant. The desktop
 * packaging step (apps/desktop/scripts/electron-build.mjs) stamps its copy of
 * the compiled server "release", with the sha256 of the engine binary it
 * bundles (one per architecture, comma-separated, on macOS), unless that build was asked for the dev variant
 * (OMNIRUSH_DESKTOP_VARIANT=dev when building). The two constants below are
 * rewritten there line by line: keep each on one line.
 */
export const BUILD_VARIANT: "dev" | "release" = "dev";
export const RELEASE_ENGINE_SHA256: string | null = null;
