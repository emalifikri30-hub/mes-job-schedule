import { expect, it } from "vite-plus/test";

// A GUARD ON THE TEST HARNESS ITSELF, not on any product code.
//
// vite.config.ts sets TZ to a zone with daylight saving so that date bugs which
// are invisible in UTC and in Indonesia fail here instead of in production. That
// setting is one line in a config file and is exactly the kind of thing a later
// "cleanup" removes without noticing — at which point every other date test in
// this repo silently gets weaker rather than failing.
//
// So the harness asserts its own premise: the process must be in a zone whose
// offset CHANGES during the year.
it("runs the suite in a zone that observes daylight saving", () => {
  const january = new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset();
  const july = new Date(Date.UTC(2026, 6, 15)).getTimezoneOffset();
  expect(january).not.toBe(july);
});
