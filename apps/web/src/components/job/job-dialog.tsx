import { AlertTriangleIcon, DownloadIcon, UploadIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { PlanRejectedError, errorMessage } from "@/lib/api";
import { rangeWindow } from "@/lib/calendar-window";
import { formatCivilLong } from "@/lib/civil-date";
import { formatSkuQuantity } from "@/lib/gantt-bars";
import { PEOPLE_FIELD, blankHeader, headerFromJob, validateHeader } from "@/lib/job-form";
import { buildPlanTemplate, parsePlanCsv, planToCsv, planToRawRows } from "@/lib/job-plan-csv";
import { useCreateJob, usePreviewPlan, useUpdateJob } from "@/lib/mutations";
import { summariseByDate, totalsByLineAndMachine } from "@/lib/plan-summary";
import {
  useJob,
  useLineProductsForLines,
  useRoleUsers,
  useWorkCenters,
  useWorkUnitsForLines,
} from "@/lib/queries";
import { useSelectedArea } from "@/components/layout/area-context";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelect } from "@/components/ui/multi-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";

import type { DateRange } from "@/lib/calendar-search";
import type { HeaderField, HeaderForm } from "@/lib/job-form";
import type { Job, JobBody, JobRole, PlanIssue, PlanPreview, RawPlanRow } from "@/lib/types";
import type { DragEvent, ReactNode } from "react";

// CREATE AND EDIT A JOB, in one dialog, in three steps.
//
//   ┌ 1 Details ───────┐   ┌ 2 Plan ─────────────────┐   ┌ 3 Confirm ────────────┐
//   │ date range *     │   │ lines ▾  [Download      │   │ Fri, 25 Sep 2026 ·    │
//   │ yields, people,  │──▶│           template]     │──▶│ Shift 1, 2, 3 · …     │
//   │ overtime, notes, │   │ ┌ drop the CSV here ┐   │   │ totals per line and   │
//   │ Managers/Foreman │   │ └───────────────────┘   │   │ machine, per SKU/unit │
//   │ /AFA             │   │ syntax errors, by row   │   │ issues, by row        │
//   └──────────────────┘   └───────── preview ───────┘   └──── Confirm = save ───┘
//
// ─────────────────────────────────────────────────────────────────────────────
// FOUR BEHAVIOURS THAT ARE DECISIONS, NOT DEFAULTS
// ─────────────────────────────────────────────────────────────────────────────
//
// 1. THE BROWSER CHECKS SYNTAX, THE SERVER RESOLVES (decision 6A). A dropped
//    file is parsed here (lib/job-plan-csv.ts) and its row-numbered syntax
//    errors are shown on the Plan step; only a clean parse is sent to
//    POST /jobs/preview, which resolves lines, machines, SKUs and units against
//    master data and reports what it could not match against the same rows.
//
// 2. A SAVE THAT FAILS ON THE PLAN STAYS ON CONFIRM (decision 15A). Master data
//    can change between preview and save, and another planner can save an
//    overlapping job first (a 409). The save answers with the same PlanPreview
//    the preview did (api.ts PlanRejectedError), so the dialog swaps in the new
//    issues and stays put — a toast saying "400" and a closed dialog would throw
//    away a plan the planner spent an afternoon on.
//
// 3. THE PEOPLE PICKERS SHOW THEIR ERROR, NEVER AN EMPTY LIST (decision 14A).
//    Their failures are configuration — a role missing in the realm, a service
//    account without view-users — and an empty picker would read as "nobody
//    holds this role", which a planner would believe and save.
//
// 4. EDIT IS THE SAME DIALOG, PREFILLED (decision 10A), and the plan is replaced
//    WHOLESALE. "Download current plan" exports the saved rows in the template's
//    own format; re-uploading replaces them. An edit that touches only the
//    header keeps the saved plan ("Keep current plan") and still goes through
//    preview, because the server re-resolves it on save regardless — better the
//    planner hears about a retired SKU on Confirm than as a failed save.
//    Preview is told the job's id so its own rows are not conflicts with itself.

type Step = "details" | "plan" | "confirm";

const STEP_IDS: Step[] = ["details", "plan", "confirm"];
const STEP_LABEL: Record<Step, string> = {
  details: "jobs.details",
  plan: "jobs.plan",
  confirm: "jobs.confirm",
};

type JobDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Present = edit, absent = create.
  jobId?: number;
  // Seeds a create — the sidebar's range, or the calendar's anchor.
  defaultRange: DateRange;
};

// How many row errors are listed before the rest are summarised. A file with a
// systematic mistake (the wrong date format in every row) would otherwise print
// 5,000 lines, burying the one sentence that says what is wrong.
const MAX_LISTED_ISSUES = 50;

function JobDialog({ open, onOpenChange, jobId, defaultRange }: JobDialogProps) {
  const { t } = useTranslation("jobs");
  const isEdit = jobId !== undefined;
  // By its two dates: the object is rebuilt on every render of the chrome, and
  // an effect depending on it would reseed the form on every render.
  const { from: defaultFrom, to: defaultTo } = defaultRange;
  const jobQuery = useJob(open ? jobId : undefined);
  const job = isEdit ? jobQuery.data : undefined;

  const [step, setStep] = useState<Step>("details");
  const [form, setForm] = useState<HeaderForm>(() => blankHeader(defaultRange));
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<HeaderField, string>>>({});
  const [lineIds, setLineIds] = useState<number[]>([]);
  // The plan that WILL be sent: the parsed upload, or the saved plan kept as is.
  const [plan, setPlan] = useState<{ rows: RawPlanRow[]; source: string } | undefined>();
  const [syntaxErrors, setSyntaxErrors] = useState<PlanIssue[]>([]);
  const [preview, setPreview] = useState<PlanPreview | undefined>();
  const [rejectedOnSave, setRejectedOnSave] = useState(false);
  const [requestError, setRequestError] = useState<string | undefined>();

  // SEEDED ONCE PER OPENING, not on every change to the job: GET /jobs/:id
  // refetches on window focus, and a reseed then would wipe a half-edited form
  // the moment the planner came back from their spreadsheet.
  const seeded = useRef(false);
  useEffect(() => {
    if (!open) {
      seeded.current = false;
      return;
    }
    if (seeded.current) return;
    if (isEdit && job === undefined) return;
    seeded.current = true;
    setStep("details");
    setForm(job ? headerFromJob(job) : blankHeader({ from: defaultFrom, to: defaultTo }));
    setFieldErrors({});
    setLineIds(job ? [...new Set(job.plan.map((r) => r.workCenterId))] : []);
    setPlan(undefined);
    setSyntaxErrors([]);
    setPreview(undefined);
    setRejectedOnSave(false);
    setRequestError(undefined);
  }, [open, isEdit, job, defaultFrom, defaultTo]);

  const previewPlan = usePreviewPlan();
  const createJob = useCreateJob();
  const updateJob = useUpdateJob();
  const saving = createJob.isPending || updateJob.isPending;

  const validated = validateHeader(form);

  const bodyFor = (rows: RawPlanRow[]): JobBody | undefined => {
    if (!validated.ok) return undefined;
    return { ...validated.header, ...validated.people, plan: rows };
  };

  const goToPlan = () => {
    if (!validated.ok) {
      setFieldErrors(validated.errors);
      return;
    }
    setFieldErrors({});
    setStep("plan");
  };

  const runPreview = async (rows: RawPlanRow[], source: string) => {
    const body = bodyFor(rows);
    if (body === undefined) return;
    setRequestError(undefined);
    setPlan({ rows, source });
    try {
      const result = await previewPlan.mutateAsync({ body, jobId });
      setPreview(result);
      setRejectedOnSave(false);
      setStep("confirm");
    } catch (err) {
      setRequestError(errorMessage(err, t("jobs.couldNotCheckPlan")));
    }
  };

  const onFile = async (file: File) => {
    setRequestError(undefined);
    const parsed = parsePlanCsv(await file.text());
    setSyntaxErrors(parsed.errors);
    if (parsed.errors.length > 0) {
      setPlan(undefined);
      return;
    }
    await runPreview(parsed.rows, file.name);
  };

  const save = async () => {
    if (plan === undefined) return;
    const body = bodyFor(plan.rows);
    if (body === undefined) return;
    setRequestError(undefined);
    try {
      if (isEdit) await updateJob.mutateAsync({ id: jobId, body });
      else await createJob.mutateAsync(body);
      toast.success(isEdit ? t("jobs.updatedToast") : t("jobs.createdToast"));
      onOpenChange(false);
    } catch (err) {
      if (err instanceof PlanRejectedError) {
        // Decision 2 in the header: the new issues replace the old, and the
        // planner stays where they can read them.
        setPreview(err.preview);
        setRejectedOnSave(true);
        return;
      }
      const message = errorMessage(err, t("jobs.saveFailedToast"));
      setRequestError(message);
      toast.error(message);
    }
  };

  const loadingJob = isEdit && job === undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] gap-0 overflow-y-auto p-0 sm:max-w-3xl">
        <DialogHeader className="border-b p-6 pb-4">
          <DialogTitle>
            {isEdit ? t("jobs.editTitle", { id: jobId }) : t("jobs.createTitle")}
          </DialogTitle>
          <DialogDescription>
            {isEdit ? t("jobs.editHint") : t("jobs.createHint")}
          </DialogDescription>
          <Stepper step={step} />
        </DialogHeader>

        <div className="space-y-5 p-6">
          {loadingJob ? (
            jobQuery.isError ? (
              <p role="alert" className="text-destructive text-sm">
                {t("jobs.couldNotLoadJob", {
                  message: errorMessage(jobQuery.error, t("jobs.requestFailed")),
                })}
              </p>
            ) : (
              <p className="text-muted-foreground text-sm">{t("jobs.loadingJob")}</p>
            )
          ) : step === "details" ? (
            <DetailsStep form={form} errors={fieldErrors} open={open} onChange={setForm} />
          ) : step === "plan" ? (
            <PlanStep
              form={form}
              job={job}
              lineIds={lineIds}
              onLinesChange={setLineIds}
              syntaxErrors={syntaxErrors}
              busy={previewPlan.isPending}
              onFile={onFile}
              onKeepCurrent={
                job
                  ? () => void runPreview(planToRawRows(job.plan), t("jobs.currentPlan"))
                  : undefined
              }
            />
          ) : preview !== undefined ? (
            <ConfirmStep preview={preview} rejectedOnSave={rejectedOnSave} source={plan?.source} />
          ) : null}

          {requestError !== undefined ? (
            <Alert variant="destructive">
              <AlertTriangleIcon />
              <AlertTitle>
                {step === "confirm" ? t("jobs.couldNotSave") : t("jobs.couldNotCheckPlan")}
              </AlertTitle>
              <AlertDescription>{requestError}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter className="border-t p-6 pt-4">
          {step !== "details" ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setStep(step === "confirm" ? "plan" : "details")}
              disabled={saving}
            >
              {t("common.back")}
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
          )}
          {step === "details" ? (
            <Button type="button" onClick={goToPlan} disabled={loadingJob}>
              {t("common.next")}
            </Button>
          ) : step === "confirm" ? (
            <Button
              type="button"
              onClick={() => void save()}
              // Nothing to save, or a plan the server has already refused: a
              // Save that is certain to fail teaches the planner to ignore the
              // issues listed above it.
              disabled={
                saving ||
                preview === undefined ||
                preview.issues.length > 0 ||
                preview.rows.length === 0
              }
            >
              {saving ? t("common.saving") : isEdit ? t("jobs.saveChanges") : t("common.confirm")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stepper({ step }: { step: Step }) {
  const { t } = useTranslation("jobs");
  const current = STEP_IDS.indexOf(step);
  return (
    <ol className="mt-3 flex items-center gap-2 text-xs" aria-label={t("jobs.steps")}>
      {STEP_IDS.map((id, i) => (
        <li
          key={id}
          aria-current={i === current ? "step" : undefined}
          className={cn(
            "flex items-center gap-1.5",
            i === current ? "text-foreground font-medium" : "text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "flex size-5 items-center justify-center rounded-full border text-[11px]",
              i <= current && "bg-primary text-primary-foreground border-primary",
            )}
          >
            {i + 1}
          </span>
          {t(STEP_LABEL[id])}
          {i < STEP_IDS.length - 1 ? <span className="text-muted-foreground px-1">›</span> : null}
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Details
// ---------------------------------------------------------------------------

const ROLE_LABEL: Record<JobRole, string> = {
  MANAGER: "jobs.managers",
  FOREMAN: "jobs.foreman",
  AFA: "jobs.afa",
};

const ROLE_PLACEHOLDER: Record<JobRole, string> = {
  MANAGER: "jobs.selectManagers",
  FOREMAN: "jobs.selectForeman",
  AFA: "jobs.selectAfa",
};

function DetailsStep({
  form,
  errors,
  open,
  onChange,
}: {
  form: HeaderForm;
  errors: Partial<Record<HeaderField, string>>;
  open: boolean;
  onChange: (next: HeaderForm) => void;
}) {
  const { t } = useTranslation("jobs");
  const set = <K extends keyof HeaderForm>(key: K, value: HeaderForm[K]) =>
    onChange({ ...form, [key]: value });

  const field = (
    key: "rollYield" | "bagYield" | "wdToday" | "rwPersonnel" | "twPersonnel",
    label: string,
    unit: string,
  ) => (
    <Field id={`job-${key}`} label={label} error={errors[key]}>
      <div className="flex items-center gap-2">
        <Input
          id={`job-${key}`}
          inputMode="decimal"
          value={form[key]}
          onChange={(e) => set(key, e.target.value)}
          aria-invalid={errors[key] !== undefined}
        />
        <span className="text-muted-foreground shrink-0 text-sm">{unit}</span>
      </div>
    </Field>
  );

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="job-start" label={t("jobs.startDate")} required error={errors.startDate}>
          <Input
            id="job-start"
            type="date"
            value={form.startDate}
            onChange={(e) => set("startDate", e.target.value)}
            aria-invalid={errors.startDate !== undefined}
          />
        </Field>
        <Field id="job-end" label={t("jobs.endDate")} required error={errors.endDate}>
          <Input
            id="job-end"
            type="date"
            value={form.endDate}
            onChange={(e) => set("endDate", e.target.value)}
            aria-invalid={errors.endDate !== undefined}
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {field("rollYield", t("jobs.rollYield"), "%")}
        {field("bagYield", t("jobs.bagYield"), "%")}
        {field("wdToday", t("jobs.wdToday"), "%")}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {field("rwPersonnel", t("jobs.rwPersonnel"), t("jobs.personShift"))}
        {field("twPersonnel", t("jobs.twPersonnel"), t("jobs.personShift"))}
      </div>

      <Field id="job-overtime" label={t("jobs.overtime")} error={errors.overtime}>
        <div className="flex flex-wrap items-center gap-4">
          <Input
            id="job-overtime"
            inputMode="decimal"
            className="w-32"
            value={form.overtime}
            onChange={(e) => set("overtime", e.target.value)}
            aria-invalid={errors.overtime !== undefined}
          />
          <RadioGroup
            value={form.overtimeUnit}
            onValueChange={(v) => set("overtimeUnit", v as HeaderForm["overtimeUnit"])}
            className="flex gap-4"
            aria-label={t("jobs.overtimeUnit")}
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="HOUR_PER_GROUP" id="ot-hour-group" />
              <Label htmlFor="ot-hour-group" className="font-normal">
                {t("jobs.hourPerGroup")}
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="PERSON_PER_HOUR" id="ot-person-hour" />
              <Label htmlFor="ot-person-hour" className="font-normal">
                {t("jobs.personPerHour")}
              </Label>
            </div>
          </RadioGroup>
        </div>
      </Field>

      <Field id="job-notes" label={t("jobs.notes")} error={errors.notes}>
        <Textarea
          id="job-notes"
          value={form.notes}
          onChange={(e) => set("notes", e.target.value)}
          rows={3}
          maxLength={2000}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        {(["MANAGER", "FOREMAN", "AFA"] as const).map((role) => (
          <PeoplePicker
            key={role}
            role={role}
            enabled={open}
            value={form[PEOPLE_FIELD[role]]}
            onChange={(ids) => set(PEOPLE_FIELD[role], ids)}
          />
        ))}
      </div>
    </div>
  );
}

// One realm role's members. See decision 3 in the header: an error is SHOWN.
function PeoplePicker({
  role,
  enabled,
  value,
  onChange,
}: {
  role: JobRole;
  enabled: boolean;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation("jobs");
  const users = useRoleUsers(role, enabled);
  const labelId = `job-people-${role}`;
  const error = users.isError ? errorMessage(users.error, t("jobs.peopleLoadError")) : undefined;

  return (
    <div className="space-y-1.5">
      <Label id={labelId}>{t(ROLE_LABEL[role])}</Label>
      <MultiSelect
        aria-labelledby={labelId}
        options={users.data ?? []}
        value={value}
        onChange={onChange}
        placeholder={t(ROLE_PLACEHOLDER[role])}
        disabledReason={
          users.data === undefined && !users.isError ? t("common.loading") : undefined
        }
        error={error}
        emptyMessage={t("jobs.nobodyHoldsRole")}
      />
      {error !== undefined ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Plan
// ---------------------------------------------------------------------------

function download(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function PlanStep({
  form,
  job,
  lineIds,
  onLinesChange,
  syntaxErrors,
  busy,
  onFile,
  onKeepCurrent,
}: {
  form: HeaderForm;
  job: Job | undefined;
  lineIds: number[];
  onLinesChange: (ids: number[]) => void;
  syntaxErrors: PlanIssue[];
  busy: boolean;
  onFile: (file: File) => Promise<void>;
  onKeepCurrent: (() => void) | undefined;
}) {
  const { t } = useTranslation("jobs");
  const { areaId } = useSelectedArea();
  const { data: lines } = useWorkCenters(areaId);
  const roster = useWorkUnitsForLines(lineIds);
  const products = useLineProductsForLines(lineIds);
  const [dragging, setDragging] = useState(false);

  const templateError = roster.error ?? products.error;
  const templateReady =
    lineIds.length > 0 && !roster.pending && !products.pending && templateError === null;

  const downloadTemplate = () => {
    const dates = rangeWindow({ from: form.startDate, to: form.endDate }).days;
    const csv = buildPlanTemplate(
      dates,
      lineIds.map((id) => ({
        name: lines?.find((l) => l.id === id)?.name ?? String(id),
        machines: roster.units.filter((u) => u.workCenterId === id),
        products: products.byLine.get(id) ?? [],
      })),
    );
    download(`job-plan-${form.startDate}_${form.endDate}.csv`, csv);
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file !== undefined) void onFile(file);
  };

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label id="job-plan-lines">{t("jobs.lines")}</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="min-w-0 flex-1">
            <MultiSelect
              aria-labelledby="job-plan-lines"
              options={lines ?? []}
              value={lineIds}
              onChange={onLinesChange}
              placeholder={t("jobs.selectLines")}
              emptyMessage={t("jobs.noLines")}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={downloadTemplate}
            // Disabled until every chosen line's machines AND SKUs are in:
            // a template built from half a roster is a plan missing machines
            // that nobody would notice until the Gantt had gaps.
            disabled={!templateReady}
          >
            <DownloadIcon /> {t("jobs.downloadTemplate")}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">{t("jobs.templateHint")}</p>
        {templateError !== null ? (
          <p role="alert" className="text-destructive text-xs">
            {t("jobs.linesLoadError", {
              message: errorMessage(templateError, t("jobs.requestFailed")),
            })}
          </p>
        ) : null}
      </div>

      {job !== undefined ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => download(`job-${job.id}-plan.csv`, planToCsv(job.plan))}
          >
            <DownloadIcon /> {t("jobs.downloadCurrent")}
          </Button>
          {onKeepCurrent !== undefined ? (
            <Button type="button" variant="outline" onClick={onKeepCurrent} disabled={busy}>
              {t("jobs.keepCurrent")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* A styled file input with drop handlers, not a dependency: the one
          thing a drop zone library adds is the drop, and that is two handlers. */}
      <label
        htmlFor="job-plan-file"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-center text-sm",
          "hover:bg-accent/50 focus-within:ring-ring focus-within:ring-2",
          dragging && "border-primary bg-primary/5",
          busy && "pointer-events-none opacity-60",
        )}
      >
        <UploadIcon className="text-muted-foreground size-6" />
        <span className="font-medium">{busy ? t("jobs.checkingPlan") : t("jobs.dropCsv")}</span>
        <span className="text-muted-foreground text-xs">
          date;line;sku;sku_code;target;machine;shift1;shift2;shift3
        </span>
        <input
          id="job-plan-file"
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          aria-label={t("jobs.planFileAria")}
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Cleared so choosing the SAME file again after fixing it fires
            // `change` — otherwise the corrected upload silently does nothing.
            e.target.value = "";
            if (file !== undefined) void onFile(file);
          }}
        />
      </label>

      {syntaxErrors.length > 0 ? (
        <IssueList
          title={t("jobs.fileUnreadable")}
          description={t("jobs.fixRows")}
          issues={syntaxErrors}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Confirm
// ---------------------------------------------------------------------------

function ConfirmStep({
  preview,
  rejectedOnSave,
  source,
}: {
  preview: PlanPreview;
  rejectedOnSave: boolean;
  source: string | undefined;
}) {
  const { t } = useTranslation("jobs");
  const days = summariseByDate(preview.rows);
  const totals = totalsByLineAndMachine(preview.rows);

  return (
    <div className="space-y-5">
      {preview.issues.length > 0 ? (
        <IssueList
          title={rejectedOnSave ? t("jobs.notSavedIssues") : t("jobs.planHasIssues")}
          description={rejectedOnSave ? t("jobs.fixRowsOnSave") : t("jobs.fixRowsAgain")}
          issues={preview.issues}
        />
      ) : null}

      <p className="text-muted-foreground text-sm">
        {source !== undefined
          ? t("jobs.planRowsFrom", { count: preview.rows.length, source })
          : t("jobs.planRowsBare", { count: preview.rows.length })}
        {preview.ignoredRows > 0
          ? ` ${t("jobs.skippedNoShift", { count: preview.ignoredRows })}`
          : ""}
      </p>

      {days.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">{t("jobs.byDate")}</h3>
          <ul className="divide-y rounded-lg border text-sm">
            {days.map((day) => (
              <li key={day.date} className="space-y-0.5 px-3 py-2">
                <div className="font-medium">
                  {t("jobs.dateShifts", {
                    date: formatCivilLong(day.date),
                    shifts: day.shifts.join(", "),
                  })}
                </div>
                <div className="text-muted-foreground">
                  {day.lines.join(", ")} · {day.machines.join(", ")}
                </div>
                <div className="text-muted-foreground">{day.skus.join(", ")}</div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {totals.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">{t("jobs.totalTarget")}</h3>
          <div className="space-y-3">
            {totals.map((line) => (
              <div key={line.workCenterId} className="rounded-lg border p-3 text-sm">
                <div className="font-medium">{line.workCenterName}</div>
                <ul className="mt-1">
                  {line.totals.map((t) => (
                    <li key={`${t.productId}-${t.unit ?? ""}`} className="tabular-nums">
                      {formatSkuQuantity(t.productName, t.total, t.unit)}
                    </li>
                  ))}
                </ul>
                <ul className="text-muted-foreground mt-2 space-y-1 border-t pt-2">
                  {line.machines.map((m) => (
                    <li key={m.workUnitId}>
                      <span className="text-foreground">{m.workUnitName}</span>:{" "}
                      <span className="tabular-nums">
                        {m.totals
                          .map((t) => formatSkuQuantity(t.productName, t.total, t.unit))
                          .join(", ")}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function IssueList({
  title,
  description,
  issues,
}: {
  title: string;
  description: string;
  issues: PlanIssue[];
}) {
  const { t } = useTranslation("jobs");
  const shown = issues.slice(0, MAX_LISTED_ISSUES);
  return (
    <Alert variant="destructive">
      <AlertTriangleIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{description}</p>
        <ul className="mt-2 space-y-0.5" aria-label={t("jobs.planIssues")}>
          {shown.map((issue, i) => (
            <li key={`${issue.row}-${issue.field}-${i}`}>
              {/* Row 0 is the job or the file as a whole, not a line of it. */}
              <span className="font-medium">
                {issue.row === 0 ? t("jobs.job") : t("jobs.rowN", { n: issue.row })}
              </span>
              {` · ${issue.field}: ${issue.message}`}
            </li>
          ))}
        </ul>
        {issues.length > shown.length ? (
          <p className="mt-1">{t("jobs.andMore", { count: issues.length - shown.length })}</p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function Field({
  id,
  label,
  required,
  error,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? (
          <span className="text-destructive" aria-hidden>
            {" "}
            *
          </span>
        ) : null}
      </Label>
      {children}
      {error !== undefined ? <p className="text-destructive text-xs">{error}</p> : null}
    </div>
  );
}

export { JobDialog };
