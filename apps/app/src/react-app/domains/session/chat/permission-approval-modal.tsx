/** @jsxImportSource react */
import { Check, ChevronRight, Clock3, HardDrive, RefreshCcw, ShieldCheck, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { displayRuntimeBrand } from "@/lib/display-runtime-brand";
import type { PendingPermission } from "@/app/types";

type PermissionPresentation = {
  title: string;
  message: string;
  permissionLabel: string;
  scopeLabel: string;
  scopeValue: string;
  isDoomLoop: boolean;
  note: string | null;
};

type PermissionDetail = {
  label: string;
  value: string;
  multiline?: boolean;
};

type PermissionApprovalModalProps = {
  permission: PendingPermission;
  sourceTitle?: string;
  busy?: boolean;
  respondPermission?: (requestID: string, reply: "once" | "always" | "reject") => void;
  safeStringify?: (value: unknown) => string;
};

const metadataDetailKeys: Array<{ key: string; labelKey: string; multiline?: boolean }> = [
  { key: "command", labelKey: "session.permission_detail_command", multiline: true },
  { key: "description", labelKey: "session.permission_detail_description" },
  { key: "cwd", labelKey: "session.permission_detail_cwd" },
  { key: "filepath", labelKey: "session.permission_detail_file" },
  { key: "filePath", labelKey: "session.permission_detail_file" },
  { key: "path", labelKey: "session.permission_detail_path" },
  { key: "target", labelKey: "session.permission_detail_target" },
  { key: "parentDir", labelKey: "session.permission_detail_parent_directory" },
  { key: "url", labelKey: "session.permission_detail_url" },
  { key: "query", labelKey: "session.permission_detail_query", multiline: true },
  { key: "subagent_type", labelKey: "session.permission_detail_agent" },
  { key: "tool", labelKey: "session.permission_detail_tool" },
  { key: "files", labelKey: "session.permission_detail_files", multiline: true },
  { key: "diff", labelKey: "session.permission_detail_diff", multiline: true },
];

function readablePermissionLabel(permission: string): string {
  if (permission === "bash") return "Bash";
  if (permission === "edit") return t("session.permission_kind_edit");
  if (permission === "read") return t("session.permission_kind_read");
  if (permission === "external_directory") return t("session.permission_kind_external_directory");
  if (permission === "task") return t("session.permission_kind_task");
  if (permission === "todowrite") return t("session.permission_kind_todowrite");
  if (permission === "question") return t("session.permission_kind_question");
  if (permission === "skill") return t("session.permission_kind_skill");
  return displayRuntimeBrand(permission);
}

function permissionCopy(permission: string): Pick<PermissionPresentation, "title" | "message"> {
  if (permission === "bash") {
    return {
      title: t("session.permission_title_bash"),
      message: t("session.permission_message_bash"),
    };
  }
  if (permission === "edit") {
    return {
      title: t("session.permission_title_edit"),
      message: t("session.permission_message_edit"),
    };
  }
  if (permission === "read") {
    return {
      title: t("session.permission_title_read"),
      message: t("session.permission_message_read"),
    };
  }
  if (permission === "external_directory") {
    return {
      title: t("session.permission_title_external_directory"),
      message: t("session.permission_message_external_directory"),
    };
  }
  if (permission === "task") {
    return {
      title: t("session.permission_title_task"),
      message: t("session.permission_message_task"),
    };
  }
  return {
    title: t("session.permission_title_generic", undefined, { permission: readablePermissionLabel(permission) }),
    message: t("session.permission_message"),
  };
}

function fileChangeLine(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const path =
    (typeof record.relativePath === "string" && record.relativePath.trim()) ||
    (typeof record.filePath === "string" && record.filePath.trim()) ||
    (typeof record.path === "string" && record.path.trim()) ||
    null;
  if (!path) return null;
  const type = typeof record.type === "string" && record.type.trim() ? record.type.trim() : "change";
  return `${type}: ${path}`;
}

function metadataValue(key: string, value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (key === "files" && Array.isArray(value)) {
    const lines = value.flatMap((item) => {
      const line = fileChangeLine(item);
      return line ? [line] : [];
    });
    return lines.length ? lines.join("\n") : null;
  }
  return null;
}

export function permissionDetailRows(metadata: Record<string, unknown>): PermissionDetail[] {
  const seen = new Set<string>();
  const rows: PermissionDetail[] = [];
  for (const item of metadataDetailKeys) {
    if (seen.has(item.labelKey)) continue;
    const value = metadataValue(item.key, metadata[item.key]);
    if (!value) continue;
    seen.add(item.labelKey);
    rows.push({
      label: t(item.labelKey),
      value: displayRuntimeBrand(value),
      multiline: item.multiline,
    });
  }
  return rows;
}

function stringifyMetadata(metadata: Record<string, unknown>, safeStringify?: (value: unknown) => string) {
  try {
    return displayRuntimeBrand(safeStringify ? safeStringify(metadata) : JSON.stringify(metadata, null, 2));
  } catch {
    return t("session.permission_metadata_unavailable");
  }
}

function isFocusableElement(element: HTMLElement) {
  if (element.hasAttribute("disabled")) return false;
  if (element.getAttribute("aria-hidden") === "true") return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

type PermissionReply = "once" | "always" | "reject";

/** Keys count only this long after the card appeared and after the last key. */
export const PERMISSION_SHORTCUT_ARM_MS = 600;
/** After "A", the confirming key counts this long after it. */
export const PERMISSION_SHORTCUT_CONFIRM_MS = 150;

/** Keyboard shortcuts of the inline approval card. */
export const PERMISSION_SHORTCUTS: Record<PermissionReply, { key: string; label: string }> = {
  once: { key: "Y", label: "Y" },
  always: { key: "A", label: "A" },
  reject: { key: "N", label: "N" },
};

/** Text fields, selects and rich editors keep their keystrokes (the composer above all). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as { closest?: unknown }).closest !== "function") return false;
  const element = target as Element;
  const tag = element.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if ((element as HTMLElement).isContentEditable) return true;
  return element.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

/**
 * The reply a key press asks for while an approval card is shown, or null:
 * Y allows once, A allows for the chat, N or Escape denies. Never while focus
 * is in an editable element, in another dialog or menu, or with a modifier.
 */
export function permissionShortcutReply(event: {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  target: EventTarget | null;
}, activeElement: Element | null = typeof document === "undefined" ? null : document.activeElement, options: { confirming?: boolean } = {}): PermissionReply | null {
  if (event.defaultPrevented || event.repeat || event.isComposing) return null;
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  if (isEditableTarget(event.target) || isEditableTarget(activeElement)) return null;
  const inOverlay = (element: EventTarget | null) =>
    !!element
    && typeof (element as { closest?: unknown }).closest === "function"
    && (element as Element).closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]') !== null;
  if (inOverlay(event.target) || inOverlay(activeElement)) return null;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (options.confirming && key === "Enter") return "once";
  if (key === "y") return "once";
  if (key === "a") return "always";
  if (key === "n" || key === "Escape") return "reject";
  return null;
}

function ShortcutHint(props: { label: string }) {
  return (
    <kbd
      aria-hidden="true"
      data-permission-shortcut={props.label}
      className="ml-1 rounded border border-current/25 px-1 font-sans text-[10px] leading-4 opacity-70"
    >
      {props.label}
    </kbd>
  );
}

function describePermissionRequest(permission: PendingPermission): PermissionPresentation {
  const patterns = permission.patterns.filter((pattern) => pattern.trim().length > 0);
  if (permission.permission === "doom_loop") {
    const tool =
      permission.metadata && typeof permission.metadata === "object" && typeof permission.metadata.tool === "string"
        ? permission.metadata.tool
        : null;

    return {
      title: t("session.doom_loop_title"),
      message: t("session.doom_loop_message"),
      permissionLabel: t("session.doom_loop_label"),
      scopeLabel: tool ? t("session.doom_loop_tool_label") : t("session.doom_loop_repeated_call_label"),
      scopeValue: displayRuntimeBrand(tool ?? (patterns.length ? patterns.join(", ") : t("session.doom_loop_repeated_tool_call"))),
      isDoomLoop: true,
      note: t("session.doom_loop_note"),
    };
  }

  const copy = permissionCopy(permission.permission);
  return {
    title: copy.title,
    message: copy.message,
    permissionLabel: readablePermissionLabel(permission.permission),
    scopeLabel: t("session.scope_label"),
    scopeValue: displayRuntimeBrand(patterns.join(", ") || t("session.permission_scope_empty")),
    isDoomLoop: false,
    note: null,
  };
}

export function PermissionApprovalModal(props: PermissionApprovalModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);
  const presentation = useMemo(() => describePermissionRequest(props.permission), [props.permission]);
  const metadata =
    props.permission.metadata && typeof props.permission.metadata === "object"
      ? props.permission.metadata
      : {};
  const hasMetadata = Object.keys(metadata).length > 0;
  const detailRows = permissionDetailRows(metadata);
  const Icon = presentation.isDoomLoop ? RefreshCcw : ShieldCheck;
  const iconClass = presentation.isDoomLoop
    ? "bg-amber-3/30 text-amber-11"
    : "bg-[rgba(var(--dls-accent-rgb),0.1)] text-dls-accent";

  useEffect(() => {
    previousActiveElementRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus({ preventScroll: true });
    return () => {
      previousActiveElementRef.current?.focus({ preventScroll: true });
    };
  }, [props.permission.id]);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.respondPermission?.(props.permission.id, "reject");
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter(isFocusableElement);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <AlertDialog open>
      <AlertDialogContent
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="w-full max-w-xl overflow-hidden sm:max-w-xl"
      >
        <AlertDialogHeader>
          <div className="flex items-start gap-4 text-left">
            <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${iconClass}`}>
              <Icon size={23} strokeWidth={1.9} />
            </div>
            <div className="min-w-0 flex-1">
              <AlertDialogTitle>
                {presentation.title}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {presentation.message}
              </AlertDialogDescription>
              {props.sourceTitle ? (
                <div
                  data-permission-source="child-session"
                  className="mt-2 text-[12px] font-medium text-amber-11"
                >
                  {t("session.permission_requested_by", { session: displayRuntimeBrand(props.sourceTitle) })}
                </div>
              ) : null}
            </div>
          </div>
        </AlertDialogHeader>

        <div className="space-y-3 px-6 py-5">
          <div className="rounded-[20px] border border-dls-border bg-dls-hover/45 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-dls-secondary">
              {t("session.permission_label")}
            </div>
            <div className="mt-2 font-mono text-[14px] leading-6 text-dls-text">
              {presentation.permissionLabel}
            </div>
            {presentation.note ? (
              <p className="mt-2 text-[13px] leading-5 text-dls-secondary">
                {presentation.note}
              </p>
            ) : null}
          </div>

          <div className="rounded-[20px] border border-dls-border bg-dls-surface p-4">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-dls-secondary">
              <HardDrive size={13} />
              {presentation.scopeLabel}
            </div>
            <div className="mt-3 rounded-2xl border border-dls-border bg-dls-hover/55 px-3.5 py-3 font-mono text-[13px] leading-6 text-dls-text">
              <span className="block break-all">{presentation.scopeValue}</span>
            </div>
          </div>

          {detailRows.length > 0 ? (
            <div className="rounded-[20px] border border-dls-border bg-dls-surface p-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-dls-secondary">
                {t("session.permission_review_label")}
              </div>
              <div className="mt-3 space-y-3">
                {detailRows.map((row) => (
                  <div key={row.label}>
                    <div className="text-[12px] font-medium text-dls-secondary">{row.label}</div>
                    <div
                      className={`mt-1 rounded-xl border border-dls-border bg-dls-hover/55 px-3 py-2 font-mono text-[12px] leading-5 text-dls-text ${
                        row.multiline ? "max-h-44 overflow-auto whitespace-pre-wrap" : "break-all"
                      }`}
                    >
                      {row.value}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {hasMetadata ? (
            <details className="group rounded-[18px] border border-dls-border bg-dls-surface px-4 py-3">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[13px] font-medium text-dls-text">
                <span>{t("session.details_label")}</span>
                <ChevronRight size={15} className="text-dls-secondary transition-transform group-open:rotate-90" />
              </summary>
              <pre className="mt-3 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-dls-border bg-dls-hover/45 px-3 py-2.5 text-[12px] leading-5 text-dls-secondary">
                {stringifyMetadata(metadata, props.safeStringify)}
              </pre>
            </details>
          ) : null}
        </div>

        <AlertDialogFooter className="flex-col gap-4">
          <p className="mb-4 text-[12px] leading-5 text-dls-secondary">
            {t("session.permission_decision_hint")}
          </p>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[1fr_auto_auto]">
            <AlertDialogAction
              variant="destructive"
              className="justify-center sm:justify-self-start"
              onClick={() => props.respondPermission?.(props.permission.id, "reject")}
              disabled={props.busy || !props.respondPermission}
            >
              <XCircle data-icon="inline-start" />
              {t("session.deny")}
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() => props.respondPermission?.(props.permission.id, "once")}
              disabled={props.busy || !props.respondPermission}
            >
              <Clock3 data-icon="inline-start" />
              {t("session.allow_once")}
            </AlertDialogAction>
            <AlertDialogAction
              variant="outline"
              onClick={() => props.respondPermission?.(props.permission.id, "always")}
              disabled={props.busy || !props.respondPermission}
            >
              <Check data-icon="inline-start" />
              {t("session.allow_for_session")}
            </AlertDialogAction>
          </div>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function PermissionApprovalPanel(props: PermissionApprovalModalProps) {
  const presentation = useMemo(() => describePermissionRequest(props.permission), [props.permission]);
  const { busy, respondPermission } = props;
  const permissionId = props.permission.id;
  // One reply per request: a held key or a second press before the card goes away is ignored.
  const repliedRef = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // A card that appears while you type must not take a key as an answer: keys
  // count only once PERMISSION_SHORTCUT_ARM_MS has passed since the card
  // appeared and since your last key. "A" (allow for this chat) asks for a
  // confirming Y (or Enter); N or Esc cancels that.
  const armedAtRef = useRef(0);
  const [confirmAlways, setConfirmAlways] = useState(false);
  const confirmAlwaysRef = useRef(false);
  useEffect(() => {
    armedAtRef.current = Date.now() + PERMISSION_SHORTCUT_ARM_MS;
    confirmAlwaysRef.current = false;
    setConfirmAlways(false);
  }, [permissionId]);

  useEffect(() => {
    if (busy || !respondPermission) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const confirming = confirmAlwaysRef.current;
      const reply = permissionShortcutReply(event, undefined, { confirming });
      if (!reply || repliedRef.current === permissionId) return;
      // With several chats side by side, the one holding focus answers its own card.
      const surface = '[data-session-surface-id]';
      const focusedSurface = document.activeElement?.closest(surface) ?? null;
      const ownSurface = rootRef.current?.closest(surface) ?? null;
      if (focusedSurface && ownSurface && focusedSurface !== ownSurface) return;
      const now = Date.now();
      if (now < armedAtRef.current) {
        armedAtRef.current = now + PERMISSION_SHORTCUT_ARM_MS;
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (confirming) {
        confirmAlwaysRef.current = false;
        setConfirmAlways(false);
        if (reply === "reject") return;
        repliedRef.current = permissionId;
        respondPermission(permissionId, "always");
        return;
      }
      if (reply === "always") {
        confirmAlwaysRef.current = true;
        setConfirmAlways(true);
        armedAtRef.current = now + PERMISSION_SHORTCUT_CONFIRM_MS;
        return;
      }
      repliedRef.current = permissionId;
      respondPermission(permissionId, reply);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, respondPermission, permissionId]);
  const metadata =
    props.permission.metadata && typeof props.permission.metadata === "object"
      ? props.permission.metadata
      : {};
  const hasMetadata = Object.keys(metadata).length > 0;
  const Icon = presentation.isDoomLoop ? RefreshCcw : ShieldCheck;

  return (
    <div ref={rootRef} data-permission-panel={permissionId} className="@container/approval overflow-hidden border-b border-dls-border bg-transparent">
        <div className="flex flex-col gap-3 px-4 py-3 @min-[36rem]/approval:flex-row @min-[36rem]/approval:items-center @min-[36rem]/approval:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover text-dls-secondary">
              <Icon size={16} strokeWidth={1.9} />
            </div>
            <div className="min-w-0">
              <div className="text-[13px] font-medium leading-5 text-dls-text">{presentation.title}</div>
              <div className="mt-0.5 text-[12px] leading-5 text-dls-secondary">{presentation.message}</div>
              {props.sourceTitle ? (
                <div
                  data-permission-source="child-session"
                  className="mt-1 text-[12px] font-medium leading-5 text-amber-11"
                >
                  {t("session.permission_requested_by", { session: displayRuntimeBrand(props.sourceTitle) })}
                </div>
              ) : null}
              {presentation.note ? (
                <div className="mt-1 text-[12px] leading-5 text-dls-secondary">{presentation.note}</div>
              ) : null}
              {confirmAlways ? (
                <div data-permission-confirm="always" role="status" className="mt-1 text-[12px] font-medium leading-5 text-amber-11">
                  {t("session.permission_confirm_always")}
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2 @min-[36rem]/approval:justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="border-red-7/25 text-red-11 hover:bg-red-1/40"
              onClick={() => props.respondPermission?.(props.permission.id, "reject")}
              disabled={props.busy || !props.respondPermission}
              aria-keyshortcuts="N Escape"
              data-permission-reply="reject"
            >
              <XCircle data-icon="inline-start" />
              {t("session.deny")}
              <ShortcutHint label={PERMISSION_SHORTCUTS.reject.label} />
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => props.respondPermission?.(props.permission.id, "once")}
              disabled={props.busy || !props.respondPermission}
              aria-keyshortcuts="Y"
              data-permission-reply="once"
            >
              <Clock3 data-icon="inline-start" />
              {t("session.allow_once")}
              <ShortcutHint label={PERMISSION_SHORTCUTS.once.label} />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => props.respondPermission?.(props.permission.id, "always")}
              disabled={props.busy || !props.respondPermission}
              aria-keyshortcuts="A"
              data-permission-reply="always"
            >
              <Check data-icon="inline-start" />
              {t("session.allow_for_session")}
              <ShortcutHint label={PERMISSION_SHORTCUTS.always.label} />
            </Button>
          </div>
        </div>

        <div className="border-t border-dls-border px-4 py-3">
          <div className="grid gap-3 @min-[36rem]/approval:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-dls-secondary">
                {t("session.permission_label")}
              </div>
              <div className="mt-1 font-mono text-[12px] leading-5 text-dls-text">
                {presentation.permissionLabel}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-dls-secondary">
                {presentation.scopeLabel}
              </div>
              <div className="mt-1 truncate rounded-lg border border-dls-border bg-dls-hover/55 px-2.5 py-1.5 font-mono text-[12px] leading-5 text-dls-text">
                {presentation.scopeValue}
              </div>
            </div>
          </div>

          {hasMetadata ? (
            <details className="group mt-3 rounded-xl border border-dls-border bg-dls-surface px-3 py-2">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[12px] font-medium text-dls-text">
                <span>{t("session.details_label")}</span>
                <ChevronRight size={14} className="text-dls-secondary transition-transform group-open:rotate-90" />
              </summary>
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-dls-hover/45 px-3 py-2 text-[11px] leading-5 text-dls-secondary">
                {stringifyMetadata(metadata, props.safeStringify)}
              </pre>
            </details>
          ) : null}
        </div>
    </div>
  );
}
