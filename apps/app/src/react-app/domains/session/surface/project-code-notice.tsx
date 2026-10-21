import { useState } from "react";
import { toast as sonnerToast } from "sonner";
import { ShieldCheck, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PROJECT_CODE_NOTICE_WHY } from "@/app/lib/project-code-notice";

/** One short line, a Details toggle with what was skipped, and a close button. */
export function ProjectCodeNoticeCard(props: { text: string; details: string[]; onDismiss: () => void; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(props.defaultOpen === true);
  return (
    <div
      className="flex w-full items-start gap-2.5 rounded-2xl border border-border bg-popover/95 py-2 pl-3 pr-1.5 text-popover-foreground shadow-md ring-1 ring-popover-border/20 backdrop-blur-sm md:max-w-sm"
      data-project-code-notice
    >
      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-[13px] leading-5">
          {props.text}{" "}
          <button
            type="button"
            className="cursor-pointer text-[12px] font-medium text-link underline-offset-2 hover:underline"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            data-project-code-notice-details-toggle
          >
            {open ? "Hide details" : "Details"}
          </button>
        </p>
        {open ? (
          <div className="flex flex-col gap-1 text-[12px] text-muted-foreground" data-project-code-notice-details>
            <p>Not loaded from this project:</p>
            <ul className="list-disc pl-4">
              {props.details.map((line) => <li key={line} className="break-words">{line}</li>)}
            </ul>
            <p>{PROJECT_CODE_NOTICE_WHY}</p>
          </div>
        ) : null}
      </div>
      <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={props.onDismiss} className="shrink-0 rounded-lg text-muted-foreground">
        <XIcon className="size-4" />
      </Button>
    </div>
  );
}

/** Shows the notice for 15 seconds (paused while the pointer is on it), or until closed. */
export function showProjectCodeNotice(notice: { id: string; text: string; details: string[] }) {
  return sonnerToast.custom(
    (id) => (
      <ProjectCodeNoticeCard text={notice.text} details={notice.details} onDismiss={() => sonnerToast.dismiss(id)} />
    ),
    { id: notice.id, duration: 15_000, position: "top-center" },
  );
}
