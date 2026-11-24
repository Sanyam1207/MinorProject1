// Issue reports (FRONTEND.md §14.3, AUTH-FACULTY.md §9). Public endpoint:
// anonymous reporters send name + email; signed-in reporters are identified
// by the server from their token (body name/email are ignored there).
import { http } from "../http.js";

export const ISSUE_DESCRIPTION_MAX = 2000;

export async function submitIssueReport({ name, email, description, pageUrl, website } = {}) {
  const body = { description: String(description ?? "").trim().slice(0, ISSUE_DESCRIPTION_MAX) };
  if (name) body.name = String(name).trim();
  if (email) body.email = String(email).trim();
  if (pageUrl) body.page = String(pageUrl).slice(0, 500);
  // Honeypot: real users never fill it; the server answers 201 without storing.
  if (website) body.website = String(website);
  const envelope = await http.post("/issue-reports", body, { raw: true });
  return {
    message: envelope?.message || "Thanks for reporting this. We'll take a look soon.",
    id: envelope?.data?.id ?? null,
  };
}
