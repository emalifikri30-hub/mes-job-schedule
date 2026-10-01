import * as React from "react";
import { CheckIcon, ChevronDownIcon, XIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// A MULTI-SELECT OVER A CATALOGUE, carrying IDS rather than labels.
//
// WHY NOT ui/select.tsx. Radix's Select is single-value by design: it closes on
// pick and its value is a string. The line and machine fields need several ids
// and must stay open while the operator works through a list, so this is a
// Popover over a checkbox list rather than a Select bent into shape.
//
// AND WHY THE OEE MODULE'S CHIP PICKER WAS NOT COPIED. mes-oee-monitor has a
// visually identical control (`ui/option-tag-input.tsx`) that stores NAMES,
// because the column it feeds is a jsonb array of strings with no id to put an
// id in. Here the opposite is true: every filter and every person on a job is
// carried by ID, and a name would make a rename silently orphan it. Same shape
// on screen, opposite contract — so it is a new control, not a copy.
//
// GENERIC OVER THE ID TYPE. Lines and machines are numeric master-data ids;
// Managers, Foremen and AFAs are Keycloak user ids, which are strings. One
// control, typed by its options, rather than a string-id copy that drifts.
//
// "SELECT ALL" IS PINNED TO THE TOP, as the requirement asks, and it is a real
// tri-state rather than a button:
//
//   none chosen   ▢  clicking selects every option
//   some chosen   ▣  clicking selects every option   <- NOT "clear"
//   all chosen    ☑  clicking clears
//
// The middle case is the one that gets written wrong. Making a partial selection
// clear on click means an operator who picked three machines and then wanted all
// twelve has to click twice and loses their three in between.

type OptionId = number | string;

type Option<T extends OptionId = number> = {
  id: T;
  name: string;
  code?: string;
};

type MultiSelectProps<T extends OptionId> = {
  options: Option<T>[];
  value: T[];
  onChange: (value: T[]) => void;
  placeholder: string;
  // Rendered in place of the list. Distinct from an empty catalogue: "choose a
  // line first" and "this line has no machines" are different answers and a
  // shared message would leave the operator poking at a control that cannot work.
  disabledReason?: string;
  // The catalogue FAILED to load. Shown on the trigger, in the destructive
  // colour, and the control is disabled — because an empty list after a failed
  // fetch reads as "there are none", and for a people picker that is a planner
  // saving a job with nobody responsible, believing nobody holds the role.
  error?: string;
  emptyMessage?: string;
  id?: string;
  "aria-labelledby"?: string;
  "aria-label"?: string;
  // The TRIGGER's classes. The header's two pickers need a narrow fixed width;
  // the dialog's want the default full width.
  className?: string;
};

function MultiSelect<T extends OptionId>({
  options,
  value,
  onChange,
  placeholder,
  disabledReason,
  error,
  emptyMessage,
  id,
  "aria-labelledby": ariaLabelledBy,
  "aria-label": ariaLabel,
  className,
}: MultiSelectProps<T>) {
  const { t } = useTranslation("jobs");
  const resolvedEmpty = emptyMessage ?? t("common.noOptions");
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");

  const selected = React.useMemo(() => new Set(value), [value]);

  // Filtered in the browser: the catalogue is a few dozen rows fetched whole
  // (lib/queries.ts says why), so a request per keystroke would be slower and
  // less reliable than a filter over an array.
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return options;
    return options.filter(
      (o) => o.name.toLowerCase().includes(q) || (o.code ?? "").toLowerCase().includes(q),
    );
  }, [options, query]);

  const allChosen = options.length > 0 && options.every((o) => selected.has(o.id));
  const someChosen = value.length > 0 && !allChosen;

  const toggle = (optionId: T) => {
    onChange(selected.has(optionId) ? value.filter((v) => v !== optionId) : [...value, optionId]);
  };

  // See the tri-state note above: a partial selection EXPANDS to all.
  const toggleAll = () => {
    onChange(allChosen ? [] : options.map((o) => o.id));
  };

  const chosen = options.filter((o) => selected.has(o.id));
  const disabled = disabledReason !== undefined || error !== undefined;

  return (
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-labelledby={ariaLabelledBy}
          aria-label={ariaLabel}
          aria-invalid={error !== undefined}
          disabled={disabled}
          className={cn(
            "flex min-h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-1.5 text-left text-sm shadow-xs",
            "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none",
            "disabled:cursor-not-allowed",
            error === undefined ? "disabled:opacity-50" : "border-destructive",
            className,
          )}
        >
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {error !== undefined ? (
              <span className="text-destructive truncate">{error}</span>
            ) : disabled ? (
              <span className="text-muted-foreground">{disabledReason}</span>
            ) : chosen.length === 0 ? (
              <span className="text-muted-foreground">{placeholder}</span>
            ) : allChosen ? (
              // A summary rather than twelve chips: the field has to stay one or
              // two lines tall inside a dialog.
              <Badge variant="secondary">{t("common.allCount", { count: chosen.length })}</Badge>
            ) : (
              <>
                {chosen.slice(0, 3).map((o) => (
                  <Badge key={String(o.id)} variant="secondary" className="max-w-40 truncate">
                    {o.name}
                  </Badge>
                ))}
                {chosen.length > 3 ? <Badge variant="secondary">+{chosen.length - 3}</Badge> : null}
              </>
            )}
          </span>
          <ChevronDownIcon className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>

      <PopoverContent className="w-(--radix-popover-trigger-width) p-0">
        <div className="border-b p-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("common.search")}
            className="h-8"
            aria-label={t("common.filterOptions")}
          />
        </div>

        <div className="max-h-64 overflow-y-auto p-1">
          {options.length === 0 ? (
            <p className="text-muted-foreground px-2 py-6 text-center text-sm">{resolvedEmpty}</p>
          ) : (
            <>
              {/* PINNED, and outside the filtered list on purpose: typing a
                  search must not be able to hide the control that selects
                  everything the search matched nothing of. */}
              <Row
                checked={allChosen}
                indeterminate={someChosen}
                onSelect={toggleAll}
                label={t("common.selectAll")}
                bold
              />
              <div className="bg-border my-1 h-px" />
              {filtered.length === 0 ? (
                <p className="text-muted-foreground px-2 py-4 text-center text-sm">
                  {t("common.noMatches")}
                </p>
              ) : (
                filtered.map((option) => (
                  <Row
                    key={String(option.id)}
                    checked={selected.has(option.id)}
                    onSelect={() => toggle(option.id)}
                    label={option.name}
                    hint={option.code}
                  />
                ))
              )}
            </>
          )}
        </div>

        {value.length > 0 ? (
          <div className="flex justify-end border-t p-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange([])}>
              <XIcon /> {t("common.clear")}
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function Row({
  checked,
  indeterminate,
  onSelect,
  label,
  hint,
  bold,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onSelect: () => void;
  label: string;
  hint?: string;
  bold?: boolean;
}) {
  return (
    <button
      type="button"
      role="option"
      // `mixed` is the accessible name for the partial state — a screen reader
      // otherwise announces a half-selected "Select all" as unchecked.
      aria-selected={indeterminate ? "true" : checked}
      aria-checked={indeterminate ? "mixed" : checked}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm",
        "hover:bg-accent hover:text-accent-foreground outline-none focus-visible:bg-accent",
        bold && "font-medium",
      )}
    >
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input",
          (checked || indeterminate) && "border-primary bg-primary text-primary-foreground",
        )}
      >
        {checked ? (
          <CheckIcon className="size-3" />
        ) : indeterminate ? (
          <span className="bg-primary-foreground h-0.5 w-2 rounded-full" />
        ) : null}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {hint ? <span className="text-muted-foreground shrink-0 text-xs">{hint}</span> : null}
    </button>
  );
}

export { MultiSelect };
export type { Option as MultiSelectOption };
