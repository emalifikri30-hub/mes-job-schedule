import { XIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { useCalendarSearch } from "@/lib/calendar-search";
import { useWorkCenters, useWorkUnitsForLines } from "@/lib/queries";
import { useSelectedArea } from "@/components/layout/area-context";
import { Button } from "@/components/ui/button";
import { MultiSelect } from "@/components/ui/multi-select";

// THE LINES AND MACHINES FILTER — two multi-selects, in the header on desktop
// and RELOCATED into the sidebar's mobile block below `md` (the same component,
// `stacked`). It replaced a popover holding one line and one machine.
//
// THE MACHINE OPTIONS ARE THE UNION OF THE SELECTED LINES' ROSTERS, fetched per
// line (lib/queries.ts `useWorkUnitsForLines`), and with no line selected the
// machine picker is disabled with a reason rather than offering every machine in
// the plant — a list of hundreds with no line beside each name is not a filter
// anybody can use.
//
// DESELECTING A LINE DROPS ITS MACHINES, in the same write. A machine left over
// from a line that is no longer selected matches nothing the other lines hold,
// so the page would go quietly empty with a machine chip still showing. The URL
// parser cannot do this (it does not know the rosters); this component can, so
// it does, in `onLinesChange`. Machines on lines that are still selected are
// KEPT — deselecting one of three lines must not throw away the machines chosen
// on the other two.

function JobFilters({ stacked = false }: { stacked?: boolean }) {
  const { t } = useTranslation("jobs");
  const { lines, machines, hasFilters, setSearch } = useCalendarSearch();
  const { areaId } = useSelectedArea();
  const { data: lineOptions } = useWorkCenters(areaId);
  const roster = useWorkUnitsForLines(lines);

  const onLinesChange = (next: number[]) => {
    const kept = new Set(next);
    const lineOf = new Map(roster.units.map((u) => [u.id, u.workCenterId]));
    setSearch({
      lines: next,
      // A machine whose line has not loaded yet is kept: its line cannot have
      // been deselected, since it was never shown as belonging to one.
      machines: machines.filter((id) => {
        const line = lineOf.get(id);
        return line === undefined || kept.has(line);
      }),
    });
  };

  // De-duplicated by machine: a machine listed under two lines would be offered
  // twice and toggle as one.
  const machineOptions = [...new Map(roster.units.map((u) => [u.id, u])).values()];

  return (
    <div className={cn("flex gap-2", stacked ? "flex-col" : "items-center")}>
      <MultiSelect
        aria-label={t("filters.byLine")}
        options={lineOptions ?? []}
        value={lines}
        onChange={onLinesChange}
        placeholder={t("filters.allLines")}
        emptyMessage={t("filters.noLines")}
        className={stacked ? undefined : "w-44"}
      />
      <MultiSelect
        aria-label={t("filters.byMachine")}
        options={machineOptions}
        value={machines}
        onChange={(next) => setSearch({ machines: next })}
        placeholder={t("filters.allMachines")}
        disabledReason={lines.length === 0 ? t("filters.chooseLineFirst") : undefined}
        error={roster.error === null ? undefined : t("filters.machinesLoadError")}
        emptyMessage={t("filters.noMachines")}
        className={stacked ? undefined : "w-44"}
      />
      {hasFilters ? (
        <Button
          variant="ghost"
          size={stacked ? "sm" : "icon"}
          aria-label={t("filters.clearAria")}
          onClick={() => setSearch({ lines: [], machines: [] })}
        >
          <XIcon />
          {stacked ? t("filters.clear") : null}
        </Button>
      ) : null}
    </div>
  );
}

export { JobFilters };
