import { cleanup } from "@testing-library/react";
import { afterEach } from "vite-plus/test";

// UNMOUNT BETWEEN TESTS, FOR EVERY TEST FILE.
//
// @testing-library/react auto-cleans only when the runner exposes its hooks as
// globals. This suite imports them explicitly (`vite-plus/test`), so nothing
// unmounts on its own and every render STACKS into the same document.body.
//
// The failure that causes is uniquely misleading: assertions do not fail with
// "not found", they fail with "FOUND MULTIPLE ELEMENTS" — naming a component
// that IS correct, in a test that IS correct, because the previous test's copy
// is still on the page. And any `queryBy*` proving something is ABSENT passes or
// fails depending on what ran before it, so the suite's meaning changes with
// file order.
//
// THIS LIVES IN A SETUP FILE RATHER THAN IN test/render.tsx, which is where it
// started. That only covered files importing the harness — a test calling
// `render` directly got no cleanup, and one did, and it failed exactly as
// described above. A setup file runs for every file in the project whether it
// imports anything or not, which is the only version of this that cannot be
// bypassed by accident.
afterEach(cleanup);
