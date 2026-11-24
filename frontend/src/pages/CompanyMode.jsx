import { useSelector } from "react-redux";
import { Briefcase, Building2, Clock, FilePlus2, UserRoundCheck } from "lucide-react";
import { getPlacementContext, listDrives } from "../lib/api/admin.js";
import DrivesPanel from "../features/tpo/DrivesPanel.jsx";
import ApplicantsPanel from "../features/tpo/ApplicantsPanel.jsx";
import { EmptyState, useAsync } from "../ui/index.js";
import BackBar from "../workspace/BackBar.jsx";
import ToolTile from "../workspace/ToolTile.jsx";
import { openPanel, panelTitle } from "../workspace/index.js";

/** Recruiter (company) workspace (FRONTEND.md §12.4): own drives and their applicants. */
export default function CompanyMode({ user }) {
  const activeFeature = useSelector((state) => state.appContext.activeFeature);
  const activePanel = useSelector((state) => state.appContext.activePanel);
  const context = useAsync(() => getPlacementContext(), [user?._id]);
  const drives = useAsync(() => listDrives({ status: "all" }), [user?._id, activeFeature]);

  const companyName = context.data?.company?.name || user?.company?.name || user?.companyName || user?.name || "Recruiter";
  const notLinked = context.data && !context.data.company;
  const items = drives.data?.items ?? [];
  const pending = items.filter((drive) => drive.status === "pending").length;
  const active = items.filter((drive) => drive.status === "active").length;
  const applicants = items.reduce((sum, drive) => sum + (drive.applicantCount ?? 0), 0);

  const tiles = [
    { icon: Briefcase, title: "MY DRIVES", description: "Your posted drives, their review status and applicant counts.", badge: `${active} ACTIVE · ${pending} IN REVIEW`, badgeClass: "bg-blue-100", onClick: () => openPanel("company.drives") },
    { icon: FilePlus2, title: "POST A DRIVE", description: "Submit a new drive; the placement office reviews it before students see it.", badge: "NEW", badgeClass: "bg-green-200", onClick: () => openPanel("company.drives", { create: true }) },
    { icon: UserRoundCheck, title: "APPLICANTS", description: "Shortlist, interview, reject and make offers across your drives.", badge: `${applicants} APPLICANTS`, badgeClass: "bg-yellow-100", onClick: () => openPanel("company.applicants") },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="card-stark bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Building2 className="h-6 w-6 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <h2 className="truncate text-lg font-black uppercase">{companyName}</h2>
              <p className="truncate text-xs font-semibold text-gray-600">
                {user?.name && user.name !== companyName ? `${user.name} · ` : ""}
                <span className="font-mono">{user?.email || ""}</span>
                {context.data?.college?.name ? ` · ${context.data.college.name}` : ""}
              </p>
            </div>
          </div>
          <span className="badge-stark bg-black text-xs text-white">RECRUITER</span>
        </div>
        {notLinked && (
          <p className="mt-3 border-2 border-black bg-yellow-100 p-2 text-[11px] font-bold">
            Your account is not linked to a company yet. Ask the placement office to update your recruiter account.
          </p>
        )}
        {pending > 0 && !activeFeature && (
          <p className="mt-3 flex items-center gap-1.5 text-[11px] font-bold text-gray-700">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" /> {pending} drive{pending === 1 ? " is" : "s are"} awaiting review by the placement office.
          </p>
        )}
      </div>

      {!activeFeature ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {tiles.map(({ title, ...tile }) => <ToolTile key={title} title={title} {...tile} />)}
        </div>
      ) : (
        <div className="space-y-4">
          <BackBar label="RECRUITER HOME" title={panelTitle(activePanel)} onBack={() => openPanel("company.home")} />
          {activeFeature === "drives" ? (
            <DrivesPanel scope="company" />
          ) : activeFeature === "applicants" ? (
            <ApplicantsPanel scope="company" />
          ) : (
            <EmptyState title="This tool isn't available" text="Go back to recruiter home and pick another tool." />
          )}
        </div>
      )}
    </div>
  );
}
