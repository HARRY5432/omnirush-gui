/** @jsxImportSource react */
import { useState } from "react";
import { LoaderCircle, ShieldAlert, ShieldCheck, ShieldEllipsis } from "lucide-react";

import type { OmniRushApprovalMode } from "@/app/lib/omnirush-server";
import { toast } from "@/components/ui/sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { t } from "@/i18n";
import { useDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";
import {
  APPROVAL_MODES,
  approvalModeLabel,
  approvalsEnvironmentHint,
  useApprovalMode,
  type ApprovalsClient,
} from "@/react-app/domains/settings/approval-mode";

export const FULL_PERMISSIONS_POLICY_LOCK =
  "Locked by your organisation: its policy does not allow changing app settings.";
export const FULL_PERMISSIONS_LOADING_HINT = "Loading the permission mode…";

const MODE_ICONS: Record<OmniRushApprovalMode, typeof ShieldCheck> = {
  careful: ShieldEllipsis,
  guarded: ShieldCheck,
  full: ShieldAlert,
};

type Props = {
  client: ApprovalsClient | null;
  /** Engine reloaded after a change; without one the setting is saved and a reload is asked for. */
  workspaceId: string | null;
};

/**
 * The composer's permissions menu (Careful / Normal / Auto), beside the model
 * selector. It shares state with Settings > General > Permissions through
 * useApprovalMode, so the two never disagree. Hidden until a server client
 * exists. The export keeps its earlier name for the composer slots.
 */
export function FullPermissionsToggle(props: Props) {
  const policyLocked = useDesktopRestriction("allowControlSettings");
  if (!props.client) return null;
  return <PermissionModeMenu client={props.client} workspaceId={props.workspaceId} policyLocked={policyLocked} />;
}

function PermissionModeMenu(props: { client: ApprovalsClient; workspaceId: string | null; policyLocked: boolean }) {
  const [open, setOpen] = useState(false);
  const { approvals, busy, status, setApprovalMode } = useApprovalMode(props.client, props.workspaceId);
  const mode = approvals?.mode ?? null;
  const lockReason = props.policyLocked
    ? FULL_PERMISSIONS_POLICY_LOCK
    : approvals
      ? approvalsEnvironmentHint(approvals)
      : null;
  // Choices are disabled while the mode loads, while a change is in flight and
  // while the environment or the organisation forces the mode; the menu still
  // opens so it can say why.
  const locked = busy || !approvals || lockReason !== null;
  const label = mode ? approvalModeLabel(mode) : null;
  const hint = lockReason ?? (label ? label.summary : (status || FULL_PERMISSIONS_LOADING_HINT));
  const Icon = mode ? MODE_ICONS[mode] : ShieldCheck;

  const select = async (next: OmniRushApprovalMode) => {
    if (locked || next === mode) return;
    setOpen(false);
    const change = await setApprovalMode(next);
    if (!change) return;
    if (change.tone === "success") toast.success(change.status);
    else if (change.tone === "warning") toast.warning(change.status);
    else toast.error(change.status);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        data-testid="full-permissions-toggle"
        data-state={mode ?? "loading"}
        data-lock-reason={lockReason ?? undefined}
        aria-label={t("permissions.trigger_label", { mode: label?.title ?? "…" })}
        aria-busy={busy || undefined}
        title={hint}
        // Same height, radius, padding and text size as the model selector
        // trigger. Auto reads as a warning (orange, alert shield): nothing asks.
        className={`flex h-9 max-h-9 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors ${
          mode === "full"
            ? "text-[color:var(--omnirush-warn,var(--orange-11))] hover:bg-orange-3"
            : "text-gray-10 hover:bg-gray-3 hover:text-gray-12"
        } ${locked ? "opacity-60" : ""}`}
      >
        {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Icon className="size-4" />}
        {/* An icon (its mode in the aria-label and title) until the composer is wide enough. */}
        <span className="hidden whitespace-nowrap @min-[760px]/composer:inline" data-testid="full-permissions-label">
          {label?.title ?? t("permissions.title")}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" sideOffset={10} className="w-[min(380px,calc(100vw-32px))] p-2">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-3 text-sm">{t("permissions.menu_label")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={mode ?? ""}>
            {APPROVAL_MODES.map((item) => {
              const ItemIcon = MODE_ICONS[item];
              const itemLabel = approvalModeLabel(item);
              return (
                <DropdownMenuRadioItem
                  key={item}
                  value={item}
                  disabled={locked}
                  data-testid={`permission-mode-${item}`}
                  aria-label={itemLabel.title}
                  onClick={() => void select(item)}
                  className={`gap-3 py-2.5 ${item === "full" ? "text-[color:var(--omnirush-warn,var(--orange-11))]" : ""}`}
                >
                  <ItemIcon className="size-5 shrink-0" />
                  <span className="min-w-0">
                    <span className="block">{itemLabel.title}</span>
                    <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{itemLabel.summary}</span>
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <p className="px-3 py-2 text-xs text-muted-foreground">{t("permissions.menu_footer")}</p>
        {lockReason ? <p role="status" data-testid="permission-mode-lock" className="px-3 pb-2 text-xs text-muted-foreground">{lockReason}</p> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
