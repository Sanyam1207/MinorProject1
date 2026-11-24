import { useState } from "react";
import { useSelector } from "react-redux";
import { LoaderCircle } from "lucide-react";
import { Tabs } from "../../ui/index.js";
import { openPanel, usePanel } from "../../workspace/index.js";
import { selectResumeWorkspace } from "../../store/aiChatSlice.js";
import { errorMessage } from "../../lib/http.js";
import ResumeGeneratorWorkspace from "../../components/ResumeGeneratorWorkspace.jsx";
import AtsPanel from "./AtsPanel.jsx";
import CatalogPanel from "./CatalogPanel.jsx";
import EditorPanel from "./EditorPanel.jsx";
import SkillGapPanel from "./SkillGapPanel.jsx";
import TailorPanel from "./TailorPanel.jsx";
import { useResumeCatalog } from "./hooks.js";
import { FULL_HEIGHT_TABS, LAB_TABS } from "./labUtils.js";

const KEEP_ALIVE = ["editor", "tailor"];

const isTailorData = (data) => Boolean(data) && typeof data === "object" && (Array.isArray(data.patches) || data.requiresManualJD === true);
const isScoreData = (data) => Boolean(data) && typeof data === "object" && Number.isFinite(data.score);

function GeneratorTab({ generator }) {
  const autosave = generator?.autosave;
  const status = autosave?.status ?? "idle";
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div
        className={`flex shrink-0 flex-wrap items-center gap-2 border-2 border-black px-3 py-2 text-xs font-bold ${
          status === "error" ? "bg-red-100" : status === "saved" ? "bg-green-100" : "bg-white"
        }`}
      >
        {status === "saving" && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
        {status === "saving"
          ? "Saving the completed resume to your Resume Bank…"
          : status === "saved"
            ? "Resume saved to your Resume Bank (it also appears in the catalog)."
            : status === "error"
              ? errorMessage(autosave?.error, "Could not save the resume.")
              : "Completed resumes are saved to your Resume Bank automatically."}
        {status === "error" && (
          <button type="button" onClick={autosave?.retry} className="btn-secondary px-2 py-1 text-[10px]">
            RETRY SAVE
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <ResumeGeneratorWorkspace workspace={generator?.workspace} onStart={generator?.onStart} saveTitle={generator?.saveTitle} />
      </div>
    </div>
  );
}

/**
 * Resume Lab (`resume.lab`): tabs catalog · editor · tailor · ats · generator · skill-gap.
 * Params come from usePanel("resume.lab"); one-shot copilot `data` (tailoring
 * patches, a ScoreResult) seeds the tailor / ats tabs. Editor and tailor stay
 * mounted once visited so unsaved edits and reviews survive tab switches.
 */
export default function ResumeLab({ user, tab = "catalog", generator, onOpenKeys }) {
  const { params, data, nonce, setParams } = usePanel("resume.lab");
  const catalog = useResumeCatalog();
  const resumeWorkspace = useSelector(selectResumeWorkspace);
  const analysis = resumeWorkspace?.analysis ?? null;
  const resumes = catalog.data?.resumes ?? [];
  const primaryId = catalog.data?.primaryId ?? null;

  const [visited, setVisited] = useState(() => [tab]);
  if (KEEP_ALIVE.includes(tab) && !visited.includes(tab)) setVisited([...visited, tab]);

  const navigate = (next) => openPanel("resume.lab", { ...params, ...next });
  const onChanged = catalog.reload;
  const fullHeight = FULL_HEIGHT_TABS.has(tab);
  const openKeys = onOpenKeys ?? (() => openPanel("settings.ai-keys"));

  const paneClass = (id) => (tab === id ? "flex min-h-0 flex-1 flex-col" : "hidden");

  return (
    <div className={fullHeight ? "flex min-h-0 flex-1 flex-col gap-3" : "space-y-3"}>
      <Tabs tabs={LAB_TABS} value={tab} onChange={(id) => navigate({ tab: id })} className="shrink-0" label="Resume Lab tools" />

      {visited.includes("editor") && (
        <div className={paneClass("editor")}>
          <EditorPanel
            resumeId={params.resumeId ?? primaryId}
            resumes={resumes}
            active={tab === "editor"}
            onNavigate={navigate}
            onChanged={onChanged}
          />
        </div>
      )}
      {visited.includes("tailor") && (
        <div className={paneClass("tailor")}>
          <TailorPanel
            params={params}
            setParams={setParams}
            seed={isTailorData(data) ? data : undefined}
            resumes={resumes}
            primaryId={primaryId}
            onNavigate={navigate}
            onOpenKeys={openKeys}
            onChanged={onChanged}
          />
        </div>
      )}

      {tab === "catalog" && <CatalogPanel onNavigate={navigate} onChanged={onChanged} />}
      {tab === "ats" && (
        <AtsPanel
          key={nonce}
          params={params}
          setParams={setParams}
          seed={isScoreData(data) ? data : undefined}
          resumes={resumes}
          analysis={analysis?.analysis_type === "score" ? analysis : null}
          onNavigate={navigate}
          onChanged={onChanged}
        />
      )}
      {tab === "skill-gap" && (
        <SkillGapPanel
          params={params}
          setParams={setParams}
          user={user}
          resumes={resumes}
          analysis={analysis?.analysis_type === "gap" ? analysis : null}
          onNavigate={navigate}
        />
      )}
      {tab === "generator" && <GeneratorTab generator={generator} />}
    </div>
  );
}
