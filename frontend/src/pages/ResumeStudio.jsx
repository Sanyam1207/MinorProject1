import { useDispatch, useSelector } from "react-redux";
import { ArrowLeft, ArrowRight, FilePlus2, Files, Gauge, KeyRound, PencilLine, ScanSearch, Wand2 } from "lucide-react";
import { openPanel, usePanel } from "../workspace/index.js";
import { runAIFeature } from "../services/aiRequestHandler.js";
import { selectActiveResumeTool } from "../store/appContextSlice.js";
import { selectResumeWorkspace, selectStudentJourney } from "../store/aiChatSlice.js";
import ResumeLab from "../features/resume/ResumeLab.jsx";
import AiKeysPanel from "../features/resume/AiKeysPanel.jsx";
import { useGeneratorAutosave } from "../features/resume/hooks.js";
import { FULL_HEIGHT_TABS, LAB_TABS, isLabTab, normalizeTool } from "../features/resume/labUtils.js";

const TOOLS = [
  { id: "catalog", title: "Catalog", description: "Upload PDF, DOCX or TeX resumes, keep versions, pick your primary.", icon: Files, badge: "VERSIONS" },
  { id: "editor", title: "Editor", description: "Edit LaTeX with line numbers and a live PDF preview.", icon: PencilLine, badge: "LATEX" },
  { id: "tailor", title: "AI Tailor", description: "Surgical keyword edits for a campus or feed job, with your own AI key.", icon: Wand2, badge: "BYOK AI" },
  { id: "ats", title: "ATS Score", description: "8-check score, keyword coverage and concrete fixes.", icon: Gauge, badge: "0–100 SCORE" },
  { id: "generator", title: "Generator", description: "Build a role-focused resume with the AI copilot.", icon: FilePlus2, badge: "AI BUILDER" },
  { id: "skill-gap", title: "Skill Gap", description: "Compare your skills and resume with a target job.", icon: ScanSearch, badge: "CAREER FIT" },
  { id: "ai-keys", title: "AI Keys", description: "Add, rename and remove your OpenAI, Anthropic, Google or xAI keys.", icon: KeyRound, badge: "ENCRYPTED" },
];

const TOOL_TITLES = Object.fromEntries([...LAB_TABS.map((tab) => [tab.id, tab.label]), ["ai-keys", "AI keys"]]);

function ToolTile({ tool, onOpen }) {
  const Icon = tool.icon;
  return (
    <button
      type="button"
      onClick={() => onOpen(tool.id)}
      className="card-stark group flex min-h-48 cursor-pointer flex-col items-center justify-between bg-white p-4 text-center transition-all hover:-translate-y-0.5 hover:bg-gray-50"
    >
      <div className="bg-black p-3.5 text-white">
        <Icon className="h-8 w-8" aria-hidden="true" />
      </div>
      <div className="mt-3">
        <h2 className="text-sm font-black uppercase group-hover:underline">{tool.title}</h2>
        <p className="mt-1 line-clamp-2 text-[11px] font-medium leading-relaxed text-gray-600">{tool.description}</p>
      </div>
      <div className="mt-3 flex w-full items-center justify-between border-t-[1.5px] border-black pt-2">
        <span className="badge-stark bg-yellow-100 text-[9px]">{tool.badge}</span>
        <span className="btn-primary px-2 py-1 text-[10px]">
          OPEN <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </span>
      </div>
    </button>
  );
}

/**
 * Resume Lab mode page `({ user })` (FRONTEND.md §12.5). The active tool comes
 * from appContext.activeResumeTool (set by openPanel). Legacy props
 * `activeTool` / `onToolChange` / `onRunGenerator` are still accepted.
 */
export default function ResumeStudio({ user, activeTool, onToolChange, onRunGenerator }) {
  const dispatch = useDispatch();
  const storeTool = useSelector(selectActiveResumeTool);
  const tool = normalizeTool(activeTool ?? storeTool);
  const resumeWorkspace = useSelector(selectResumeWorkspace);
  const journey = useSelector(selectStudentJourney);
  const keysPanel = usePanel("settings.ai-keys");
  // Kept here (mounted for every resume tool) so completed runs save even off the generator tab.
  const autosave = useGeneratorAutosave(resumeWorkspace, journey?.selectedJob ?? null);

  const runGenerator = () => {
    if (onRunGenerator) onRunGenerator();
    else dispatch(runAIFeature("resume-generator"));
  };

  const goTo = (next) => {
    if (onToolChange) return onToolChange(next);
    if (!next) return openPanel("resume.home");
    if (next === "ai-keys") return openPanel("settings.ai-keys");
    return openPanel("resume.lab", { tab: next });
  };

  const openTool = (id) => {
    goTo(id);
    if (id === "generator") runGenerator();
  };

  const target = journey?.selectedJob;
  const role = target?.roleTitle || target?.title;
  const company = target?.companyName || target?.company_name || (typeof target?.company === "string" ? target.company : target?.company?.name);
  const generator = {
    workspace: resumeWorkspace,
    onStart: runGenerator,
    autosave,
    saveTitle: role ? (company ? `${company} ${role}` : role) : "Generated resume",
  };

  const fullHeight = isLabTab(tool) && FULL_HEIGHT_TABS.has(tool);

  return (
    <div className={fullHeight ? "flex h-full min-h-0 flex-col gap-3 overflow-hidden" : "space-y-4"}>
      {!tool && (
        <div className="card-stark flex flex-col justify-between gap-3 bg-white sm:flex-row sm:items-center">
          <div>
            <h1 className="text-lg font-black uppercase tracking-tight">Resume Lab</h1>
            <p className="text-xs font-medium text-gray-600">Create, organise, score and tailor every version of your resume.</p>
          </div>
          <span className="badge-stark bg-black text-[10px] text-white">LATEX + AI</span>
        </div>
      )}

      {tool ? (
        <>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-[1.5px] border-black bg-white p-2.5 shadow-bold-sm">
            <button type="button" onClick={() => goTo(null)} className="btn-secondary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" /> BACK TO RESUME LAB HOME
            </button>
            <span className="badge-stark max-w-full truncate bg-black text-xs font-extrabold uppercase text-white">{TOOL_TITLES[tool] || "Resume Lab"}</span>
          </div>
          {tool === "ai-keys" ? <AiKeysPanel key={keysPanel.nonce} /> : <ResumeLab user={user} tab={tool} generator={generator} />}
        </>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {TOOLS.map((item) => (
            <ToolTile key={item.id} tool={item} onOpen={openTool} />
          ))}
        </div>
      )}
    </div>
  );
}
