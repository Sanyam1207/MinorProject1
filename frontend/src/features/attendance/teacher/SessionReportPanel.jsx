import { ArrowLeft, FileText } from "lucide-react";
import { listCourses } from "../../../lib/api/attendance.js";
import Panel from "../../../ui/Panel.jsx";
import { useAsync } from "../../../ui/useAsync.js";
import { usePanel } from "../../../workspace/index.js";
import { CoursePicker } from "./parts.jsx";
import SessionPicker from "./SessionPicker.jsx";
import SessionReportView from "./SessionReportView.jsx";

/** teacher.report — one session's roster with manual overrides + CSV, or a picker of ended classes. */
export default function SessionReportPanel() {
  const { params, nonce, setParams } = usePanel("teacher.report");
  return (
    <Panel
      title="Session report"
      icon={FileText}
      actions={
        params.sessionId ? (
          <button type="button" onClick={() => setParams({ sessionId: undefined })} className="btn-secondary min-h-11 px-2.5 py-1 text-[11px] sm:min-h-0">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> ALL REPORTS
          </button>
        ) : null
      }
    >
      {params.sessionId ? (
        <SessionReportView key={`${params.sessionId}:${nonce}`} sessionId={params.sessionId} />
      ) : (
        <ReportPicker key={nonce} courseId={params.courseId} onCourse={(courseId) => setParams({ courseId })} onPick={(session) => setParams({ sessionId: session._id })} />
      )}
    </Panel>
  );
}

function ReportPicker({ courseId, onCourse, onPick }) {
  const courses = useAsync(() => listCourses({ status: "all" }), []);
  return (
    <div className="space-y-3">
      <CoursePicker className="sm:w-72" courses={courses.data ?? []} value={courseId} allowAll onChange={onCourse} />
      <SessionPicker courseId={courseId} status="ended,live" onPick={onPick} emptyText="Reports appear here after a class is held. Start a class from the schedule or the home screen." />
    </div>
  );
}
