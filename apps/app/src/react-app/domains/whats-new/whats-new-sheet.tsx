/** @jsxImportSource react */
// The "What's new" sheet (right side) and the one-time toast after an update.
import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";

import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Toaster, toast } from "@/components/ui/sonner";
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
  takeUpdateDecision,
  useWhatsNewStore,
  type WhatsNewRelease,
} from "./whats-new";

const UPDATE_TOAST_ID = "whats-new-update";
const UPDATE_TOAST_MS = 12_000;
const UPDATE_TOAST_SETTLE_MS = 2_500;
/** Its own toaster: bottom right but above the chat's composer (the main toaster sits at the window's edge). */
const UPDATE_TOASTER_ID = "whats-new";
const UPDATE_TOASTER_OFFSET = { bottom: 168, right: 24 };

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
  return (
    <div className="flex flex-col gap-2">
      {releases.map((release) => (
        <ReleaseCard key={release.version} release={release} current={release.version === version} />
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
          <span className="text-xs text-muted-foreground">{t("whats_new.release_count", { count: desktopReleases.length })}</span>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

let updateDecisionTaken = false;
let updateToastDue = false;

/** "Updated to X": once per version, after an upgrade, never while a turn runs or an approval waits. */
export function WhatsNewUpdateToast() {
  const turnRunning = useSessionActivityStore((store) => hasLiveSessionActivity(store.statusesByWorkspaceId));
  const [due, setDue] = useState(() => {
    if (!updateDecisionTaken) {
      updateDecisionTaken = true;
      updateToastDue = takeUpdateDecision();
    }
    return updateToastDue;
  });
  const shown = useRef(false);

  useEffect(() => {
    if (!due || turnRunning || shown.current) return;
    // A short settle so the chats' running state (read from the server after start) can hold it back.
    const timer = window.setTimeout(() => {
      shown.current = true;
      updateToastDue = false;
      const version = buildAppVersion();
      markUpdateToastShown(version);
      setDue(false);
      toast(t("whats_new.updated_toast", { version }), {
        id: UPDATE_TOAST_ID,
        duration: UPDATE_TOAST_MS,
        action: { label: t("whats_new.title"), onClick: () => openWhatsNew("toast") },
        toasterId: UPDATE_TOASTER_ID,
      });
    }, UPDATE_TOAST_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [due, turnRunning]);

  return <Toaster id={UPDATE_TOASTER_ID} position="bottom-right" offset={UPDATE_TOASTER_OFFSET} mobileOffset={UPDATE_TOASTER_OFFSET} />;
}
