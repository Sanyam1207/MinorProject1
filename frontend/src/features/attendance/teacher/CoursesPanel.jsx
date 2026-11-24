import { useState } from "react";
import { ArrowLeft, BookOpen, ChevronRight, Plus, Users } from "lucide-react";
import { listCourses } from "../../../lib/api/attendance.js";
import EmptyState from "../../../ui/EmptyState.jsx";
import ErrorState from "../../../ui/ErrorState.jsx";
import LoadingState from "../../../ui/LoadingState.jsx";
import Panel from "../../../ui/Panel.jsx";
import { useAsync } from "../../../ui/useAsync.js";
import { usePanel } from "../../../workspace/index.js";
import CourseCreate from "./CourseCreate.jsx";
import CourseDetail from "./CourseDetail.jsx";
import { istDateTime } from "./ist.js";
import { Toggle } from "./parts.jsx";

/** teacher.courses — list, create (params.create) and detail (params.courseId, params.tab). */
export default function CoursesPanel() {
  const { params, nonce, setParams } = usePanel("teacher.courses");
  const [showArchived, setShowArchived] = useState(false);
  const courses = useAsync(() => listCourses(showArchived ? { status: "all" } : {}), [showArchived, nonce]);

  const back = () => setParams({ courseId: undefined, create: false, tab: "overview" });
  const mode = params.create ? "create" : params.courseId ? "detail" : "list";

  return (
    <Panel
      title={mode === "create" ? "New course" : "My courses"}
      icon={BookOpen}
      badge={mode === "list" && courses.data ? `${courses.data.length} COURSE${courses.data.length === 1 ? "" : "S"}` : undefined}
      actions={
        mode === "list" ? (
          <button type="button" onClick={() => setParams({ create: true, courseId: undefined })} className="btn-primary min-h-11 px-2.5 py-1 text-[11px] sm:min-h-0">
            <Plus className="h-3.5 w-3.5" aria-hidden="true" /> CREATE COURSE
          </button>
        ) : (
          <button type="button" onClick={back} className="btn-secondary min-h-11 px-2.5 py-1 text-[11px] sm:min-h-0">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> ALL COURSES
          </button>
        )
      }
    >
      {mode === "create" && (
        <CourseCreate
          key={nonce}
          onCancel={back}
          onCreated={(course) => {
            courses.reload();
            setParams({ create: false, courseId: course?._id, tab: "overview" });
          }}
        />
      )}
      {mode === "detail" && (
        <CourseDetail
          key={`${params.courseId}:${nonce}`}
          courseId={params.courseId}
          tab={params.tab ?? "overview"}
          onTab={(tab) => setParams({ tab })}
          onChanged={courses.reload}
          onArchived={courses.reload}
        />
      )}
      {mode === "list" && (
        <CourseList
          state={courses}
          showArchived={showArchived}
          onShowArchived={setShowArchived}
          onOpen={(course) => setParams({ courseId: course._id, tab: "overview" })}
          onCreate={() => setParams({ create: true })}
        />
      )}
    </Panel>
  );
}

function CourseList({ state, showArchived, onShowArchived, onOpen, onCreate }) {
  if (state.loading && !state.data) return <LoadingState label="LOADING COURSES…" />;
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.reload} />;
  const courses = state.data ?? [];
  return (
    <div className="space-y-3">
      {courses.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title={showArchived ? "No courses" : "No active courses"}
          text="Create a course with its weekly timetable. Students join with a code, by email or by auto-enrolment, and are notified of every class."
          action={
            <button type="button" onClick={onCreate} className="btn-primary min-h-11 px-3 text-xs sm:min-h-0">
              <Plus className="h-3.5 w-3.5" aria-hidden="true" /> CREATE COURSE
            </button>
          }
        />
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {courses.map((course) => (
            <li key={course._id}>
              <button
                type="button"
                onClick={() => onOpen(course)}
                className={`flex h-full min-h-11 w-full flex-col gap-1 border-2 border-black p-3 text-left transition-all hover:-translate-y-0.5 hover:bg-gray-50 ${course.status === "archived" ? "bg-gray-100" : "bg-white"}`}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="font-mono text-sm font-black">{course.code}</span>
                  <span className="flex items-center gap-1">
                    {course.status === "archived" && <span className="badge-stark bg-gray-200 text-[9px]">ARCHIVED</span>}
                    {course.joinCode && <span className="badge-stark bg-yellow-100 font-mono text-[9px]">{course.joinCode}</span>}
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                  </span>
                </span>
                <span className="line-clamp-2 text-xs font-bold">{course.name}</span>
                <span className="text-[10px] font-semibold text-gray-600">
                  {[course.branch, course.semester ? `Sem ${course.semester}` : null, course.section ? `Sec ${course.section}` : null].filter(Boolean).join(" · ") || "—"}
                </span>
                <span className="mt-auto flex flex-wrap items-center gap-2 border-t-[1.5px] border-black pt-1.5 text-[10px] font-bold">
                  <span className="inline-flex items-center gap-1">
                    <Users className="h-3 w-3" aria-hidden="true" /> {course.studentCount} students
                  </span>
                  <span className="text-gray-600">
                    {course.nextSession
                      ? course.nextSession.status === "live"
                        ? "LIVE NOW"
                        : `Next: ${istDateTime(course.nextSession.startsAt)}`
                      : "No upcoming class"}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="sm:w-80">
        <Toggle checked={showArchived} onChange={onShowArchived} label="Show archived courses" />
      </div>
    </div>
  );
}
