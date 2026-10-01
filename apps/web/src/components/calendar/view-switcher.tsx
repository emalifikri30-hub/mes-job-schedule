import { useTranslation } from "react-i18next";

import { i18n } from "@/lib/i18n";
import { CALENDAR_VIEW_MODES } from "@/lib/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import type { CalendarViewMode } from "@/lib/types";

// The six views, in the order the requirement lists them.
//
// `fourDay` IS THE DEFAULT and is deliberately NOT first in this list: the order
// here is the one an operator scans (shortest span to longest, then the list),
// while the default is set in the route's search-param schema. Ordering the
// select to advertise the default would put "4 days" above "Day", which reads
// as a mistake.
const LABEL_KEYS: Record<CalendarViewMode, string> = {
  day: "calendar.day",
  week: "calendar.week",
  month: "calendar.month",
  year: "calendar.year",
  schedule: "calendar.schedule",
  fourDay: "calendar.fourDays",
};

const ORDER: CalendarViewMode[] = ["day", "week", "month", "year", "schedule", "fourDay"];

function ViewSwitcher({
  value,
  onChange,
}: {
  value: CalendarViewMode;
  onChange: (mode: CalendarViewMode) => void;
}) {
  const { t } = useTranslation("jobs");
  return (
    <Select value={value} onValueChange={(v) => onChange(v as CalendarViewMode)}>
      <SelectTrigger className="w-32" aria-label={t("calendar.view")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ORDER.map((mode) => (
          <SelectItem key={mode} value={mode}>
            {t(LABEL_KEYS[mode])}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Exported so the header can name the current view without a second copy of the
// map — and so a view added to CALENDAR_VIEW_MODES without a label here fails to
// compile rather than rendering blank.
function viewLabel(mode: CalendarViewMode): string {
  return i18n.t(LABEL_KEYS[mode], { ns: "jobs" });
}

export { ViewSwitcher, viewLabel, CALENDAR_VIEW_MODES };
