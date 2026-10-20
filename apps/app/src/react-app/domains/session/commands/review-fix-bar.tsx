/** @jsxImportSource react */
import { useState } from "react";
import { Wrench } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { REVIEW_SEVERITIES, severityLabel, type ReviewSeverity, type ReviewSummary } from "./review-message";

const CHIP: Record<ReviewSeverity, string> = {
  critical: "border-red-6/50 bg-red-3/50 text-red-11",
  high: "border-orange-6/50 bg-orange-3/50 text-orange-11",
  medium: "border-amber-6/50 bg-amber-3/50 text-warning",
  low: "border-gray-6/60 bg-gray-3/50 text-gray-11",
};

/** Under a review reply with issues: how many of each severity, and "Fix these" (the engine's fix command). */
export function ReviewFixBar(props: { review: ReviewSummary; disabled?: boolean; onFix: () => void }) {
  const total = props.review.issues.length;
  // One click sends one fix command; the bar goes away once its turn starts.
  const [sent, setSent] = useState(false);
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 px-2 @min-[40rem]/chatpane:px-10" data-testid="review-fix-bar">
      {REVIEW_SEVERITIES.filter((severity) => props.review.counts[severity] > 0).map((severity) => (
        <span
          key={severity}
          className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] font-medium", CHIP[severity])}
          data-review-severity={severity}
        >
          {props.review.counts[severity]} {severityLabel(severity)}
        </span>
      ))}
      <Button
        size="sm"
        className="h-7 rounded-full px-3 text-xs"
        data-testid="review-fix-these"
        disabled={props.disabled || sent}
        onClick={() => {
          if (sent) return;
          setSent(true);
          props.onFix();
        }}
        title={total > 0 ? `Ask the agent to fix ${total === 1 ? "this issue" : `these ${total} issues`}` : "Ask the agent to fix the issues"}
      >
        <Wrench className="size-3.5" />
        Fix these
      </Button>
    </div>
  );
}
