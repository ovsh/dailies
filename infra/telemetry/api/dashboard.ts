import { dashboardPage } from "../lib/dashboard-page";

/** Served at /dashboard through the rewrite in vercel.json. */
export function GET(): Response {
  return dashboardPage();
}
