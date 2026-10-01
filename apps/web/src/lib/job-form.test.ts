import { describe, expect, it } from "vite-plus/test";

import { MAX_JOB_DAYS, blankHeader, validateHeader } from "@/lib/job-form";

import type { HeaderForm } from "@/lib/job-form";

// The Details step's rules. The server's dto is the guarantee; these exist so a
// planner hears about a mistake next to the field rather than as a 400 three
// steps later — so what is tested is that each one fires, and that blank means
// NULL rather than zero.

function form(overrides: Partial<HeaderForm> = {}): HeaderForm {
  return { ...blankHeader({ from: "2026-10-01", to: "2026-10-10" }), ...overrides };
}

describe("dates", () => {
  it("accepts a range, one day long or longer", () => {
    expect(validateHeader(form()).ok).toBe(true);
    expect(validateHeader(form({ endDate: "2026-10-01" })).ok).toBe(true);
  });

  it("refuses an end before the start", () => {
    const r = validateHeader(form({ endDate: "2026-09-30" }));
    expect(r.ok === false && r.errors.endDate).toMatch(/before/);
  });

  it(`refuses a span of ${MAX_JOB_DAYS} days or more — the api's cap`, () => {
    // 1 Oct + 61 days = 1 Dec is the last allowed end.
    expect(validateHeader(form({ endDate: "2026-12-01" })).ok).toBe(true);
    expect(validateHeader(form({ endDate: "2026-12-02" })).ok).toBe(false);
  });

  it("refuses a missing date", () => {
    expect(validateHeader(form({ startDate: "" })).ok).toBe(false);
  });
});

describe("numbers", () => {
  it("sends BLANK as NULL, never as zero", () => {
    // Zero RW personnel is a statement; blank is "not planned".
    const r = validateHeader(form());
    expect(r.ok && r.header).toMatchObject({ rollYield: null, rwPersonnel: null, overtime: null });
  });

  it("accepts a percentage with either decimal mark, up to 100", () => {
    const r = validateHeader(form({ rollYield: "97,5", bagYield: "100" }));
    expect(r.ok && r.header).toMatchObject({ rollYield: 97.5, bagYield: 100 });
    expect(validateHeader(form({ wdToday: "140" })).ok).toBe(false);
  });

  it("wants whole people", () => {
    expect(validateHeader(form({ rwPersonnel: "4.5" })).ok).toBe(false);
    const r = validateHeader(form({ twPersonnel: "6" }));
    expect(r.ok && r.header.twPersonnel).toBe(6);
  });
});

describe("overtime and its unit — both or neither", () => {
  it("drops the unit when no overtime is given", () => {
    // The radio always has a value; sending it alone would be a 400.
    const r = validateHeader(form({ overtimeUnit: "PERSON_PER_HOUR" }));
    expect(r.ok && r.header.overtimeUnit).toBeNull();
  });

  it("sends the unit with the overtime", () => {
    const r = validateHeader(form({ overtime: "2", overtimeUnit: "PERSON_PER_HOUR" }));
    expect(r.ok && r.header).toMatchObject({ overtime: 2, overtimeUnit: "PERSON_PER_HOUR" });
  });
});

describe("notes", () => {
  it("sends a blank note as NULL", () => {
    const r = validateHeader(form({ notes: "   " }));
    expect(r.ok && r.header.notes).toBeNull();
  });
});
