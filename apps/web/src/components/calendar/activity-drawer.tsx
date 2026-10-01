import { ArrowRightIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { useActivityFeed } from "@/lib/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";

import type { ActivityAction, ActivityEntry } from "@/lib/types";
import type { LucideIcon } from "lucide-react";

// THE AUDIT TRAIL — "Log Activity" in the sidebar.
//
// WHAT IT IS FOR, which decides most of what follows: answering "who changed
// this, and when" months after the fact. Not "what is on the calendar now" —
// that is the calendar.
//
// THREE THINGS IT DOES THAT A PLAIN LIST WOULD NOT:
//
// 1. IT SHOWS DELETED JOBS. Their `jobId` is null, because the row outlives
//    the job on purpose. Filtering them out would hide the single most
//    important thing an audit trail records.
// 2. IT RENDERS THE SERVER'S WORDING. `changes` arrives already worded —
//    "Roll yield", "95%" → "97%", or a one-line "Plan rows" summary. This component does not re-derive it,
//    which is what keeps an entry from 2026 readable by whatever the UI becomes.
// 3. IT PAGES ON A CURSOR. The log is append-only and grows while it is read.

const ACTION_STYLE: Record<ActivityAction, { icon: LucideIcon; className: string }> = {
  CREATED: {
    icon: PlusIcon,
    className: "text-emerald-600 dark:text-emerald-400",
  },
  UPDATED: {
    icon: PencilIcon,
    className: "text-amber-600 dark:text-amber-400",
  },
  DELETED: { icon: Trash2Icon, className: "text-destructive" },
};

const ACTION_LABEL: Record<ActivityAction, string> = {
  CREATED: "activity.created",
  UPDATED: "activity.updated",
  DELETED: "activity.deleted",
};

function ActivityDrawer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Gated on `open`: the feed is never on screen otherwise, and fetching it on
  // every page load would be a request nobody reads.
  //
  // THAT GATE IS ALSO THE TRAP. A query with `enabled: false` reports
  // `status: "pending"` forever, so branching on `isPending` first would render
  // a skeleton that never resolves in the far more common case where the drawer
  // has never been opened. The branch below is on whether there is DATA.
  const { t } = useTranslation("jobs");
  const feed = useActivityFeed(open);
  const entries = feed.data?.pages.flat() ?? [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="border-b">
          <SheetTitle>{t("activity.title")}</SheetTitle>
          <SheetDescription>{t("activity.intro")}</SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-4">
          {feed.isError ? (
            <p className="text-destructive py-8 text-center text-sm">{t("activity.loadError")}</p>
          ) : feed.data === undefined ? (
            <div className="space-y-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : entries.length === 0 ? (
            <p className="text-muted-foreground py-8 text-center text-sm">{t("activity.empty")}</p>
          ) : (
            <ol className="space-y-3">
              {entries.map((entry) => (
                <ActivityRow key={entry.id} entry={entry} />
              ))}
            </ol>
          )}

          {feed.hasNextPage ? (
            <div className="pt-4 text-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void feed.fetchNextPage()}
                disabled={feed.isFetchingNextPage}
              >
                {feed.isFetchingNextPage ? t("common.loading") : t("activity.loadOlder")}
              </Button>
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const { t } = useTranslation("jobs");
  const style = ACTION_STYLE[entry.action];
  const Icon = style.icon;
  const deleted = entry.jobId === null;

  return (
    <li className="rounded-lg border p-3">
      <div className="flex items-start gap-2">
        <Icon className={cn("mt-0.5 size-4 shrink-0", style.className)} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span className={cn("text-sm font-medium", style.className)}>
              {t(ACTION_LABEL[entry.action])}
            </span>
            <span className="truncate text-sm font-medium">{entry.jobLabel}</span>
            {/* The job is gone. Said plainly, because the row still names it
                and a reader would otherwise go looking for it on the calendar. */}
            {deleted ? (
              <Badge variant="outline" className="text-muted-foreground">
                {t("activity.gone")}
              </Badge>
            ) : null}
          </div>

          <p className="text-muted-foreground mt-0.5 text-xs">
            {/* `actorName` is display-only and may be absent; the durable
                identity is the subject, which is not worth showing but is what
                the row is really keyed on. */}
            {entry.actorName ?? entry.actorId} · {formatWhen(entry.at)}
          </p>

          {/* Only an UPDATE carries a diff. A create and a delete get null
              rather than [], which is why this is a null check and not a
              length check — the two mean different things. */}
          {entry.changes === null ? null : (
            <ul className="mt-2 space-y-1">
              {entry.changes.map((change, i) => (
                <li
                  key={`${change.field}-${i}`}
                  className="flex flex-wrap items-center gap-1 text-xs"
                >
                  <span className="text-muted-foreground">{change.field}:</span>
                  <span className="bg-muted rounded px-1 py-0.5 line-through opacity-70">
                    {change.from}
                  </span>
                  <ArrowRightIcon className="text-muted-foreground size-3 shrink-0" />
                  <span className="bg-muted rounded px-1 py-0.5 font-medium">{change.to}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </li>
  );
}

// An absolute local timestamp, NOT "3 hours ago".
//
// A relative time is friendlier and wrong for this screen: an audit trail is
// read to establish when something happened, and "2 months ago" cannot be
// compared against a shift record or an incident report.
function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export { ActivityDrawer, formatWhen };
