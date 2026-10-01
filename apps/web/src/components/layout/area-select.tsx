import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { useSelectedArea } from "@/components/layout/area-context";
import { useAreas } from "@/lib/queries";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// The area picker. It scopes which LINES the filters and the create dialog may
// offer; it is not itself a request filter, because core-api's endpoints take a
// workCenterId and know nothing about areas.
//
// `className` exists because this renders in TWO places at different widths: a
// fixed w-40 in the header on desktop, and full-width in the sidebar on mobile
// (see the mobile section in app-sidebar.tsx). Passing the width in beats a
// `variant` prop, which would be a flag encoding "which of my two call sites is
// this" — the thing this codebase's shared components avoid.
function AreaSelect({ className }: { className?: string } = {}) {
  const { t } = useTranslation("jobs");
  const { data: areas, isPending, isError } = useAreas();
  const { areaId, setAreaId } = useSelectedArea();

  if (isPending) return <Skeleton className={cn("h-9 w-24", className)} />;
  // No areas means no line filter is possible; say so rather than showing an
  // empty dropdown that looks broken.
  if (isError || areas.length === 0) {
    return <span className="text-muted-foreground text-sm">{t("area.none")}</span>;
  }

  return (
    <Select
      value={areaId === undefined ? "" : String(areaId)}
      onValueChange={(v) => setAreaId(Number(v))}
    >
      <SelectTrigger className={cn("w-40", className)} aria-label={t("area.label")}>
        <SelectValue placeholder={t("area.label")} />
      </SelectTrigger>
      <SelectContent>
        {areas.map((area) => (
          <SelectItem key={area.id} value={String(area.id)}>
            {area.code}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export { AreaSelect };
