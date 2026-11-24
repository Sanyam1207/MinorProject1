import { BarChart3, BookOpen } from "lucide-react";
import { listCourses } from "../../../lib/api/attendance.js";
import EmptyState from "../../../ui/EmptyState.jsx";
import ErrorState from "../../../ui/ErrorState.jsx";
import LoadingState from "../../../ui/LoadingState.jsx";
import Panel from "../../../ui/Panel.jsx";
import { useAsync } from "../../../ui/useAsync.js";
import { openPanel, usePanel } from "../../../workspace/index.js";
import CourseReportView from "./CourseReportView.jsx";
import { CoursePicker } from "./parts.jsx";

/** teacher.analytics — per-student attendance, defaulters and notices. */
export default function CourseAnalyticsPanel() {
  const { params, nonce, setParams } = usePanel("teacher.analytics");
  const courses = useAsync(() => listCourses({ status: "all" }), []);
  const list = courses.data ?? [];
  const courseId = params.courseId ?? (list.length === 1 ? list[0]._id : undefined);

  return (
    <Panel title="Course analytics" icon={BarChart3}>
      {courses.loading && !courses.data ? (
        <LoadingState label="LOADING COURSES…" />
      ) : courses.error ? (
        <ErrorState error={courses.error} onRetry={courses.reload} />
      ) : list.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No courses yet"
          text="Create a course to see attendance analytics."
          action={
            <button type="button" onClick={() => openPanel("teacher.courses", { create: true })} className="btn-primary min-h-11 px-3 text-xs sm:min-h-0">
              CREATE COURSE
            </button>
          }
        />
      ) : (
        <div className="space-y-4">
          <CoursePicker className="sm:w-80" courses={list} value={courseId} onChange={(id) => setParams({ courseId: id, threshold: undefined })} />
          {courseId ? (
            <CourseReportView
              key={`${courseId}:${nonce}`}
              courseId={courseId}
              threshold={params.threshold}
              onThresholdChange={(threshold) => setParams({ threshold })}
            />
          ) : (
            <EmptyState icon={BarChart3} title="Pick a course" text="Choose a course to see who is below the attendance minimum." />
          )}
        </div>
      )}
    </Panel>
  );
}
