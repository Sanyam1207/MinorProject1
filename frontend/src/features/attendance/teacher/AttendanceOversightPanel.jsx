import { useState } from "react";
import { ArrowLeft, BookOpen, ChevronRight, Search, ShieldCheck, Users } from "lucide-react";
import { listCourses } from "../../../lib/api/attendance.js";
import EmptyState from "../../../ui/EmptyState.jsx";
import ErrorState from "../../../ui/ErrorState.jsx";
import LoadingState from "../../../ui/LoadingState.jsx";
import Panel from "../../../ui/Panel.jsx";
import Tabs from "../../../ui/Tabs.jsx";
import { useAsync } from "../../../ui/useAsync.js";
import { usePanel } from "../../../workspace/index.js";
import CourseReportView from "./CourseReportView.jsx";
import SessionPicker from "./SessionPicker.jsx";
import SessionReportView from "./SessionReportView.jsx";

/** tpo.attendance — read-only attendance oversight of every course (tpo / admin). */
export default function AttendanceOversightPanel() {
  const { params, nonce, setParams } = usePanel("tpo.attendance");
  const courses = useAsync(() => listCourses({ status: "all" }), [nonce]);
  const list = courses.data ?? [];
  const course = list.find((item) => item._id === params.courseId) ?? null;

  let body;
  if (params.sessionId) {
    body = (
      <div className="space-y-3">
        <button type="button" onClick={() => setParams({ sessionId: undefined })} className="btn-secondary min-h-11 px-3 text-xs sm:min-h-0">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> {params.courseId ? "BACK TO COURSE" : "ALL COURSES"}
        </button>
        <SessionReportView key={`${params.sessionId}:${nonce}`} sessionId={params.sessionId} readOnly />
      </div>
    );
  } else if (params.courseId) {
    body = (
      <CourseOversight
        key={`${params.courseId}:${nonce}`}
        courseId={params.courseId}
        course={course}
        threshold={params.threshold}
        onThreshold={(threshold) => setParams({ threshold })}
        onBack={() => setParams({ courseId: undefined, threshold: undefined })}
        onSession={(sessionId) => setParams({ sessionId })}
      />
    );
  } else if (courses.loading && !courses.data) {
    body = <LoadingState label="LOADING COURSES…" />;
  } else if (courses.error) {
    body = <ErrorState error={courses.error} onRetry={courses.reload} />;
  } else {
    body = <CourseDirectory courses={list} onOpen={(item) => setParams({ courseId: item._id })} />;
  }

  return (
    <Panel title="Attendance oversight" icon={ShieldCheck} badge="READ-ONLY">
      {body}
    </Panel>
  );
}

function CourseDirectory({ courses, onOpen }) {
  const [query, setQuery] = useState("");
  if (!courses.length) {
    return <EmptyState icon={BookOpen} title="No courses yet" text="Courses appear here once faculty create them in Teacher mode." />;
  }
  const needle = query.trim().toLowerCase();
  const rows = courses.filter(
    (course) =>
      !needle ||
      [course.code, course.name, course.branch, course.section, course.teacher?.name].some((value) => String(value ?? "").toLowerCase().includes(needle)),
  );
  return (
    <div className="space-y-3">
      <label className="relative block sm:w-72">
        <span className="sr-only">Search courses</span>
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" aria-hidden="true" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Course, branch or teacher" className="input-stark w-full pl-7 text-base sm:text-xs" />
      </label>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse border-2 border-black text-left text-xs">
          <thead>
            <tr className="bg-black text-white uppercase">
              <th className="border-2 border-black p-2">Course</th>
              <th className="border-2 border-black p-2">Teacher</th>
              <th className="border-2 border-black p-2">Class</th>
              <th className="border-2 border-black p-2">Students</th>
              <th className="border-2 border-black p-2"><span className="sr-only">Open</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((course) => (
              <tr key={course._id} className={course.status === "archived" ? "bg-gray-50 text-gray-600" : ""}>
                <td className="border-2 border-black p-2">
                  <div className="font-mono font-black">{course.code}</div>
                  <div className="font-semibold">{course.name}</div>
                  {course.status === "archived" && <span className="badge-stark bg-gray-200 text-[9px]">ARCHIVED</span>}
                </td>
                <td className="border-2 border-black p-2">{course.teacher?.name ?? "—"}</td>
                <td className="border-2 border-black p-2">
                  {[course.branch, course.semester ? `Sem ${course.semester}` : null, course.section].filter(Boolean).join(" · ") || "—"}
                </td>
                <td className="border-2 border-black p-2 tabular-nums">
                  <span className="inline-flex items-center gap-1">
                    <Users className="h-3 w-3" aria-hidden="true" /> {course.studentCount}
                  </span>
                </td>
                <td className="border-2 border-black p-1.5">
                  <button type="button" onClick={() => onOpen(course)} className="btn-primary min-h-11 px-2 py-1 text-[10px] sm:min-h-0">
                    REPORT <ChevronRight className="h-3 w-3" aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="text-center text-[11px] font-semibold text-gray-500">No courses match.</p>}
    </div>
  );
}

function CourseOversight({ courseId, course, threshold, onThreshold, onBack, onSession }) {
  const [tab, setTab] = useState("students");
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" onClick={onBack} className="btn-secondary min-h-11 px-3 text-xs sm:min-h-0">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> ALL COURSES
        </button>
        {course && (
          <div className="text-right">
            <div className="font-mono text-sm font-black">{course.code}</div>
            <div className="text-[11px] font-semibold text-gray-600">
              {course.name}
              {course.teacher?.name ? ` · ${course.teacher.name}` : ""}
            </div>
          </div>
        )}
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        label="Course report sections"
        tabs={[
          { id: "students", label: "Students" },
          { id: "sessions", label: "Classes" },
        ]}
      />
      {tab === "students" ? (
        <CourseReportView courseId={courseId} threshold={threshold} onThresholdChange={onThreshold} readOnly />
      ) : (
        <SessionPicker courseId={courseId} status="ended,live,cancelled,missed" days={120} aheadDays={0} onPick={(session) => onSession(session._id)} emptyTitle="No classes held yet" />
      )}
    </div>
  );
}
