// UI-ACTIONS.md §12 scenario 1 — registry integrity.
import "./helpers/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PANELS, PANELS_BY_ROLE, PANEL_ID_ALIASES, resolvePanel, resolveTarget } from "../src/workspace/panels.js";
import { ROLE_MODES } from "../src/workspace/modes.js";

const ROLES = ["student", "teacher", "tpo", "admin", "company", "alumni"];

// UI-ACTIONS.md §4, copied verbatim.
const SPEC_PANELS_BY_ROLE = {
  student: ["student.home", "jobs.matched", "jobs.campus", "jobs.market", "jobs.tracker", "jobs.detail",
    "applications", "offers", "training", "calendar", "portfolio",
    "attendance.student", "attendance.scan", "schedule", "interview", "learning",
    "resume.home", "resume.lab", "settings.ai-keys", "alumni", "pr-outreach",
    "notifications", "profile", "report-issue"],
  teacher: ["teacher.home", "teacher.courses", "teacher.schedule", "teacher.live", "teacher.report",
    "teacher.analytics", "notifications", "profile", "report-issue"],
  tpo: ["tpo.home", "tpo.job-creator", "tpo.gap-analysis", "tpo.drives", "tpo.applicants", "tpo.offers",
    "tpo.policy", "tpo.analytics", "tpo.training", "tpo.calendar", "tpo.job-feed", "tpo.faculty",
    "tpo.recruiters", "tpo.attendance", "tpo.issues", "pr-outreach", "notifications", "profile", "report-issue"],
  admin: ["tpo.home", "tpo.job-creator", "tpo.gap-analysis", "tpo.drives", "tpo.applicants", "tpo.offers",
    "tpo.policy", "tpo.analytics", "tpo.training", "tpo.calendar", "tpo.job-feed", "tpo.faculty",
    "tpo.recruiters", "tpo.attendance", "tpo.issues", "pr-outreach", "notifications", "profile", "report-issue"],
  company: ["company.home", "company.drives", "company.applicants", "notifications", "profile", "report-issue"],
  alumni: ["alumni", "notifications", "profile", "report-issue"],
};

// Every panel id produced by agent tools (UI-ACTIONS §10 / AGENT-TOOLS §5) and notifications (§11).
const PRODUCED_PANEL_IDS = [
  "attendance.student", "teacher.courses", "tpo.attendance", "schedule", "teacher.schedule", "teacher.live",
  "teacher.report", "teacher.analytics", "attendance.scan", "jobs.campus", "tpo.drives", "company.drives",
  "jobs.detail", "applications", "offers", "tpo.offers", "training", "tpo.training", "tpo.applicants",
  "company.applicants", "tpo.analytics", "jobs.market", "tpo.job-feed", "jobs.tracker", "resume.lab",
  "tpo.faculty", "tpo.recruiters", "tpo.issues", "notifications",
];

test("PANELS_BY_ROLE deep-equals UI-ACTIONS.md §4", () => {
  assert.deepEqual(PANELS_BY_ROLE, SPEC_PANELS_BY_ROLE);
});

test("PANELS_BY_ROLE lists exactly the panels each role may open directly", () => {
  for (const role of ROLES) {
    const direct = Object.keys(PANELS).filter((id) => PANELS[id].roles.includes(role)).sort();
    assert.deepEqual([...PANELS_BY_ROLE[role]].sort(), direct, role);
  }
});

test("every panel id produced by tools and notifications exists", () => {
  for (const id of PRODUCED_PANEL_IDS) assert.ok(PANELS[id], `missing panel ${id}`);
  for (const [deprecated, canonical] of Object.entries(PANEL_ID_ALIASES)) {
    assert.ok(PANELS[canonical], `alias target ${canonical} for ${deprecated}`);
    assert.equal(resolvePanel(deprecated, "tpo").panelId, canonical);
  }
});

test("every role alias exists and is directly allowed for that role", () => {
  for (const [id, panel] of Object.entries(PANELS)) {
    for (const [role, target] of Object.entries(panel.aliases)) {
      assert.ok(PANELS[target], `${id}: alias target ${target} missing`);
      assert.ok(PANELS[target].roles.includes(role), `${id}: alias ${target} not allowed for ${role}`);
    }
  }
});

test("every workspace panel's mode is allowed for each of its roles", () => {
  for (const [id, panel] of Object.entries(PANELS)) {
    if (panel.target.overlay) continue;
    for (const role of panel.roles) {
      const target = resolveTarget(id, role, {});
      assert.ok(target?.mode, `${id} has no mode for ${role}`);
      assert.ok(ROLE_MODES[role].includes(target.mode), `${id}: mode ${target.mode} not allowed for ${role}`);
    }
  }
});
