/** @jsxImportSource react */
// The "What's new" sheet (right side) and the one-time toast after an update.
import { useEffect, useState } from "react";
import { ExternalLink, Sparkles, XIcon } from "lucide-react";

import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { usePlatform } from "../../kernel/platform";
import { hasLiveSessionActivity, useSessionActivityStore } from "../session/status/session-activity-store";
import {
  NATIVE_MENU_WHATS_NEW_EVENT,
  WHATS_NEW_CHANGELOG_URL,
  buildAppVersion,
  closeWhatsNew,
  desktopReleases,
  displayVersion,
  inlineParts,
  markUpdateToastShown,
  openWhatsNew,
  releasesFor,
  takeUpdateDecision,
  updateSummary,
  useWhatsNewStore,
  type WhatsNewRelease,
} from "./whats-new";

const UPDATE_TOAST_MS = 12_000;
const UPDATE_TOAST_SETTLE_MS = 2_500;
const UPDATE_TOAST_WIDTH = 360;
/** Below this chat-column width the toast becomes a full-width strip. */
const UPDATE_TOAST_STRIP_BELOW = 480;
const UPDATE_TOAST_GAP = 12;

const GROUPS = [
  { key: "new", label: () => t("whats_new.group_new"), dot: "bg-primary" },
  { key: "improved", label: () => t("whats_new.group_improved"), dot: "bg-violet-9" },
  { key: "fixed", label: () => t("whats_new.group_fixed"), dot: "bg-green-9" },
] as const;

export function WhatsNewText({ text }: { text: string }) {
  return (
    <>
      {inlineParts(text).map((part, index) =>
        part.code ? (
          <code key={index} className="rounded border border-border bg-muted px-1 py-px font-mono text-[0.85em] text-foreground">
            {part.text}
          </code>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

function formatDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function ReleaseCard({ release, current }: { release: WhatsNewRelease; current: boolean }) {
  return (
    <section
      data-whats-new-release={release.version}
      data-current={current ? "true" : undefined}
      aria-label={release.version}
      className={cn(
        "rounded-xl px-4 py-3",
        current ? "border border-primary/70 bg-muted/40 ring-1 ring-primary/20" : "border border-transparent",
      )}
    >
      <header className="flex items-baseline gap-2">
        <h3 className="font-mono text-sm font-semibold text-foreground">{release.version}</h3>
        {current ? (
          <span className="rounded-full border border-primary/60 bg-primary/10 px-2 py-px text-[11px] font-medium text-foreground">
            {t("whats_new.current")}
          </span>
        ) : null}
        <span className="ms-auto text-xs text-muted-foreground">{formatDate(release.date)}</span>
      </header>
      {GROUPS.map((group) => {
        const items = release[group.key];
        if (!items.length) return null;
        return (
          <div key={group.key} className="mt-2" data-whats-new-group={group.key}>
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <span className={cn("size-1.5 rounded-full", group.dot)} aria-hidden="true" />
              {group.label()}
            </div>
            <ul className="mt-1 list-disc space-y-1 ps-5 text-[13px] leading-relaxed text-foreground marker:text-muted-foreground">
              {items.map((item, index) => (
                <li key={index}>
                  <WhatsNewText text={item} />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

/** The release cards, newest first; the running version first with a badge. */
export function WhatsNewReleases({ releases = desktopReleases, version }: { releases?: readonly WhatsNewRelease[]; version: string }) {
  const shown = releasesFor(version, releases);
  return (
    <div className="flex flex-col gap-2">
      {shown.releases.map((release) => (
        <ReleaseCard key={release.version} release={release} current={release.version === shown.current} />
      ))}
    </div>
  );
}

export function WhatsNewSheet() {
  const open = useWhatsNewStore((state) => state.open);
  const platform = usePlatform();
  const version = displayVersion();

  useEffect(() => {
    const onNativeMenu = () => openWhatsNew("native_menu");
    window.addEventListener(NATIVE_MENU_WHATS_NEW_EVENT, onNativeMenu);
    return () => window.removeEventListener(NATIVE_MENU_WHATS_NEW_EVENT, onNativeMenu);
  }, []);

  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : closeWhatsNew())}>
      <SheetContent
        side="right"
        data-testid="whats-new-sheet"
        className="gap-0 data-[side=right]:w-[min(448px,90vw)] data-[side=right]:sm:max-w-[448px]"
      >
        <SheetHeader className="border-b border-border px-5 pt-5 pb-4 pe-14">
          <SheetTitle className="text-lg font-semibold">{t("whats_new.title")}</SheetTitle>
          <SheetDescription>{t("whats_new.subtitle", { version })}</SheetDescription>
        </SheetHeader>
        <div
          className="min-h-0 flex-1 overflow-y-auto px-3 py-3 focus-visible:outline-none"
          data-testid="whats-new-body"
          tabIndex={0}
          role="region"
          aria-label={t("whats_new.title")}
        >
          <WhatsNewReleases version={version} />
        </div>
        <SheetFooter className="flex-row items-center justify-between border-t border-border px-5 py-3">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded text-sm font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => platform.openLink(WHATS_NEW_CHANGELOG_URL)}
          >
            {t("whats_new.all_releases")}
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </button>
          <span className="text-xs text-muted-foreground">{t("whats_new.release_count", { count: releasesFor(version).releases.length })}</span>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

let updateDecisionTaken = false;
let updateToastDue = false;

type ToastPlacement = { left?: number; right: number; bottom: number; width?: number; strip: boolean };

/**
 * Where the update toast sits: above the chat's composer stack (the composer
 * plus the run status and session-quality rows over it), right-aligned to the
 * composer, or as a full-width strip inside a narrow chat column. Without a
 * composer on screen: the window's bottom-right corner.
 */
export function updateToastPlacement(
  shell: { left: number; right: number; top: number; width: number } | null,
  panel: { right: number } | null,
  viewport: { width: number; height: number },
): ToastPlacement {
  if (!shell) return { right: 24, bottom: 24, strip: false };
  const bottom = Math.max(12, viewport.height - shell.top + UPDATE_TOAST_GAP);
  if (shell.width < UPDATE_TOAST_STRIP_BELOW) {
    return { left: shell.left + 12, right: Math.max(12, viewport.width - shell.right + 12), bottom, strip: true };
  }
  const edge = panel ? Math.min(panel.right, shell.right - 12) : shell.right - 16;
  return { right: Math.max(12, viewport.width - edge), bottom, width: Math.min(UPDATE_TOAST_WIDTH, shell.width - 24), strip: false };
}

function composerAnchor(): { shell: DOMRect; panel: DOMRect | null } | null {
  const visible = (el: Element) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? rect : null;
  };
  const shells = [...document.querySelectorAll("[data-composer-shell]")].flatMap((el) => {
    const rect = visible(el);
    return rect ? [{ el, rect }] : [];
  });
  const shell = shells.at(-1);
  if (shell) {
    const panelEl = shell.el.querySelector("[data-composer-panel]");
    return { shell: shell.rect, panel: panelEl ? visible(panelEl) : null };
  }
  // The new-chat screen: the composer alone, high on the page.
  const panels = [...document.querySelectorAll("[data-composer-panel]")].flatMap((el) => visible(el) ?? []);
  const panel = panels.at(-1);
  return panel ? { shell: panel, panel } : null;
}

function useToastPlacement(active: boolean): ToastPlacement {
  const [placement, setPlacement] = useState<ToastPlacement>({ right: 24, bottom: 24, strip: false });
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const anchor = composerAnchor();
        const next = updateToastPlacement(anchor?.shell ?? null, anchor?.panel ?? null, { width: window.innerWidth, height: window.innerHeight });
        setPlacement((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      });
    };
    measure();
    // The composer grows with the draft, panels open and close: follow it while the toast is up.
    const timer = window.setInterval(measure, 250);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(timer);
      window.removeEventListener("resize", measure);
    };
  }, [active]);
  return placement;
}

export function UpdateToastCard(props: { version: string; summary: string; onOpen: () => void; onClose: () => void; strip?: boolean }) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="whats-new-toast"
      data-strip={props.strip ? "true" : undefined}
      className="flex w-full items-start gap-3 rounded-2xl border border-border bg-popover/95 p-4 text-popover-foreground shadow-md ring-1 ring-popover-border/20 backdrop-blur-sm"
    >
      <Sparkles className="mt-0.5 size-4 shrink-0 text-foreground" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-sm font-semibold">{t("whats_new.updated_title", { version: props.version })}</p>
        {props.summary ? <p className="text-sm text-muted-foreground">{props.summary}</p> : null}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={props.onOpen}>{t("whats_new.title")}</Button>
          <Button size="sm" variant="ghost" onClick={props.onClose}>{t("whats_new.later")}</Button>
        </div>
      </div>
      <Button size="icon-sm" variant="ghost" aria-label={t("whats_new.close")} onClick={props.onClose} className="-me-1 -mt-1 shrink-0">
        <XIcon className="size-4" />
      </Button>
    </div>
  );
}

/** "Updated to X": once per version, after an upgrade, never while a turn runs or an approval waits. */
export function WhatsNewUpdateToast() {
  const turnRunning = useSessionActivityStore((store) => hasLiveSessionActivity(store.statusesByWorkspaceId));
  const sheetOpen = useWhatsNewStore((state) => state.open);
  const [due, setDue] = useState(() => {
    if (!updateDecisionTaken) {
      updateDecisionTaken = true;
      updateToastDue = takeUpdateDecision();
    }
    return updateToastDue;
  });
  const [visible, setVisible] = useState(false);
  const [hovered, setHovered] = useState(false);
  const placement = useToastPlacement(visible);
  const version = buildAppVersion();

  useEffect(() => {
    if (!due || turnRunning) return;
    // A short settle so the chats' running state (read from the server after start) can hold it back.
    const timer = window.setTimeout(() => {
      updateToastDue = false;
      markUpdateToastShown(version);
      setDue(false);
      setVisible(true);
    }, UPDATE_TOAST_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [due, turnRunning, version]);

  // Hides by itself (not while the pointer is on it); opening the notes from anywhere closes it.
  useEffect(() => {
    if (!visible || hovered) return;
    const timer = window.setTimeout(() => setVisible(false), UPDATE_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [visible, hovered]);
  useEffect(() => {
    if (sheetOpen) setVisible(false);
  }, [sheetOpen]);

  if (!visible) return null;
  const { current } = releasesFor(version);
  const release = desktopReleases.find((entry) => entry.version === current);
  return (
    <div
      className="fixed z-40"
      style={{ left: placement.left, right: placement.right, bottom: placement.bottom, width: placement.strip ? undefined : placement.width ?? UPDATE_TOAST_WIDTH }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocusCapture={() => setHovered(true)}
      onBlurCapture={() => setHovered(false)}
    >
      <UpdateToastCard
        version={version}
        summary={updateSummary(release)}
        strip={placement.strip}
        onOpen={() => {
          setVisible(false);
          openWhatsNew("toast");
        }}
        onClose={() => setVisible(false)}
      />
    </div>
  );
}
