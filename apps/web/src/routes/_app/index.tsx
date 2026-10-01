import { createFileRoute, redirect } from "@tanstack/react-router";

// `/` HAS NO SCREEN OF ITS OWN. The module's landing page is the calendar — the
// requirement says the initial page is `/calendar` — so this route redirects
// rather than rendering a dashboard nobody asked for.
//
// A redirect in `beforeLoad` rather than a component that navigates on mount:
// the second renders a frame of empty page first, and on a slow connection that
// frame is what the operator sees after signing in.
export const Route = createFileRoute("/_app/")({
  beforeLoad: () => {
    throw redirect({ to: "/calendar", replace: true });
  },
});
