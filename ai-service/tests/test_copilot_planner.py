"""Offline planner (PYTHON.md §5.9): intents, extractors, clarifications."""

import pytest

from fakes import make_manifest
from app.agents.copilot import planner
from app.agents.copilot.planner import PlannedCall, PlannerReply
from app.agents.copilot.session import AwaitingInput
from app.agents.jobscrapper.session_store import session_job_store
from app.agents.modes import AgentMode
from app.agents.roles import ROLE_DENIED_TEXT

SID = "u1:s1"
TEACHER = make_manifest("teacher")
STUDENT = make_manifest("student")
TPO = make_manifest("tpo")


def plan(text, manifest=TEACHER, role="teacher", **kw):
    return planner.plan(text, role=role, manifest=manifest, session_id=SID, **kw)


def assert_call(outcome, tool, args):
    assert isinstance(outcome, PlannedCall), outcome
    assert outcome.tool == tool
    assert outcome.args == args


# -- 1-8 teacher scheduling / attendance ---------------------------------------

def test_schedule_with_everything():
    assert_call(plan("Schedule DBMS class tomorrow at 10am for 90 minutes in LT-2"), "attendance_schedule_class",
                {"course": "DBMS", "when": "tomorrow at 10am", "durationMinutes": 90, "room": "LT-2"})


def test_schedule_one_hour():
    assert_call(plan("schedule DBMS class tomorrow at 10am for 1 hour in LT-2"), "attendance_schedule_class",
                {"course": "DBMS", "when": "tomorrow at 10am", "durationMinutes": 60, "room": "LT-2"})


def test_schedule_course_code_and_weekday():
    assert_call(plan("schedule CS301 next monday 2:30 pm"), "attendance_schedule_class",
                {"course": "CS301", "when": "next monday 2:30 pm"})


def test_schedule_without_class_word():
    assert_call(plan("Schedule DBMS tomorrow 10am in LT-2"), "attendance_schedule_class",
                {"course": "DBMS", "when": "tomorrow 10am", "room": "LT-2"})


def test_auto_schedule():
    assert_call(plan("find a free slot for CS301 this week, 2 hours"), "attendance_auto_schedule_class",
                {"course": "CS301", "durationMinutes": 120, "within": "this week"})


def test_cancel_class():
    assert_call(plan("cancel tomorrow's DBMS class"), "attendance_cancel_class", {"course": "DBMS", "when": "tomorrow"})


def test_reschedule_class():
    assert_call(plan("move the CS301 class from friday to monday 11am"), "attendance_reschedule_class",
                {"course": "CS301", "from": "friday", "when": "monday 11am"})


def test_start_and_end_session():
    assert_call(plan("start attendance for CS301"), "attendance_start_session", {"course": "CS301"})
    assert_call(plan("end the session"), "attendance_end_session", {})


def test_mark_manual():
    assert_call(plan("mark 2021CS045 as absent"), "attendance_mark_manual", {"student": "2021CS045", "status": "absent"})


def test_notify_defaulters():
    assert_call(plan("notify students below 75% in CS301"), "attendance_notify_defaulters",
                {"course": "CS301", "threshold": 75})


def test_teacher_reports():
    assert_call(plan("show attendance for CS301"), "attendance_course_report", {"course": "CS301"})
    assert_call(plan("who was absent today"), "attendance_session_report", {"date": "today"})
    assert_call(plan("list my courses"), "attendance_list_courses", {})


# -- 9-13 student ---------------------------------------------------------------

def test_student_attendance_intents():
    assert_call(plan("what's my attendance?", STUDENT, "student"), "attendance_my_summary", {})
    assert_call(plan("what’s my attendance", STUDENT, "student"), "attendance_my_summary", {})
    assert_call(plan("scan the qr", STUDENT, "student"), "attendance_open_scanner", {})
    assert_call(plan("join course with code K7M2QP", STUDENT, "student"), "attendance_join_course", {"joinCode": "K7M2QP"})
    assert_call(plan("my classes this week", STUDENT, "student"), "attendance_my_schedule", {"days": 7})


def test_applications_with_status():
    assert_call(plan("show my applications that are shortlisted", STUDENT, "student"), "applications_list",
                {"status": "shortlisted"})


def test_withdraw_is_not_a_listing():
    assert_call(plan("withdraw my application to Infosys", STUDENT, "student"), "application_withdraw", {"job": "Infosys"})


def _listed_jobs():
    session_job_store.replace_jobs(SID, [
        {"id": "c1", "kind": "campus", "source": "campus", "title": "SDE", "company_name": "Acme", "saveable": False},
        {"id": "m2", "kind": "external", "source": "debugwithshubham", "title": "Analyst", "company_name": "Northwind",
         "saveable": True, "application_url": "https://example.com/jobs/1"},
    ])


def test_job_references_against_the_listed_jobs():
    _listed_jobs()
    assert_call(plan("apply to the 1st job", STUDENT, "student"), "drive_apply", {"job": "c1"})
    assert_call(plan("save job 2", STUDENT, "student"), "market_job_save", {"job": "m2"})

    campus = plan("save job 1", STUDENT, "student")
    assert isinstance(campus, PlannerReply)
    assert "campus drive" in campus.text and "Applications" in campus.text

    out_of_range = plan("apply to job 7", STUDENT, "student")
    assert isinstance(out_of_range, PlannerReply)
    assert out_of_range.text.startswith("I can only see 2 job(s)")


def test_offer_respond():
    assert_call(plan("accept the Infosys offer", STUDENT, "student"), "offer_respond", {"decision": "accept", "job": "Infosys"})


def test_market_search():
    assert_call(plan("find python internships in Pune", STUDENT, "student"), "jobs_search_market",
                {"query": "python", "jobType": "internship", "location": "Pune"})


# -- 14 help ---------------------------------------------------------------------

def test_help_lists_manifest_and_role_specialists():
    teacher_help = plan("what can you do")
    assert isinstance(teacher_help, PlannerReply)
    assert "Schedule a class for one of the teacher's courses." in teacher_help.text
    assert "mock interviews" not in teacher_help.text
    assert "Open a panel" not in teacher_help.text  # open_panel is never listed

    student_help = plan("what can you do", STUDENT, "student")
    assert "mock interviews" in student_help.text


def test_greeting_uses_first_name():
    reply = plan("hi", STUDENT, "student", actor_name="Asha Verma")
    assert isinstance(reply, PlannerReply)
    assert reply.text.startswith("Hi Asha! ")
    assert plan("hello there", STUDENT, "student").text.startswith("Hi there! ")


# -- 15 clarification + awaiting ----------------------------------------------------

def test_missing_course_asks_and_resumes():
    reply = plan("schedule a class tomorrow at 10")
    assert isinstance(reply, PlannerReply)
    assert reply.kind == "clarify"
    assert reply.text.startswith("Which course?")
    assert reply.awaiting == AwaitingInput("attendance_schedule_class", {"when": "tomorrow at 10"}, "course", None)

    resumed = planner.continue_awaiting("CS301", reply.awaiting, manifest=TEACHER, session_id=SID)
    assert_call(resumed, "attendance_schedule_class", {"course": "CS301", "when": "tomorrow at 10"})


def test_awaiting_is_dropped_for_a_different_request():
    awaiting = AwaitingInput("attendance_schedule_class", {"when": "tomorrow at 10"}, "course", None)
    assert planner.continue_awaiting("show my notifications", awaiting, manifest=TEACHER, session_id=SID) is None


# -- 16 tool missing from the manifest ------------------------------------------------

def test_student_never_plans_a_teacher_tool():
    outcome = plan("start attendance for CS301", STUDENT, "student")
    assert not (isinstance(outcome, PlannedCall) and outcome.tool == "attendance_start_session")


# -- 17 AMBIGUOUS memory ------------------------------------------------------------

def test_ambiguous_candidates_by_number_and_label():
    candidates = [{"id": "k1", "label": "CS301 · Sec A"}, {"id": "k2", "label": "CS301 · Sec B"}]
    awaiting = AwaitingInput("attendance_start_session", {"course": "CS301"}, "course", candidates)
    assert_call(planner.continue_awaiting("2", awaiting, manifest=TEACHER, session_id=SID),
                "attendance_start_session", {"course": "k2"})
    assert_call(planner.continue_awaiting("cs301 · sec a", awaiting, manifest=TEACHER, session_id=SID),
                "attendance_start_session", {"course": "k1"})
    assert_call(planner.continue_awaiting("Sec B", awaiting, manifest=TEACHER, session_id=SID),
                "attendance_start_session", {"course": "k2"})
    assert planner.continue_awaiting("9", awaiting, manifest=TEACHER, session_id=SID) is None


# -- 18 denied mode -----------------------------------------------------------------

def test_denied_mode_text_for_a_student():
    reply = plan("post a job for Infosys", STUDENT, "student", denied_mode=AgentMode.JOB_CREATION)
    assert isinstance(reply, PlannerReply)
    assert reply.kind == "denied"
    assert reply.text.startswith(ROLE_DENIED_TEXT[AgentMode.JOB_CREATION])


def test_unknown_request_falls_back_to_capabilities():
    reply = plan("tell me a joke about compilers", STUDENT, "student")
    assert isinstance(reply, PlannerReply)
    assert reply.kind == "unknown"
    assert reply.text.startswith("I'm not sure how to help with that yet.")


def test_tpo_intents():
    assert_call(plan("show applicants for Infosys SDE", TPO, "tpo"), "applicants_list", {"job": "Infosys SDE"})
    assert_call(plan("close the Infosys drive", TPO, "tpo"), "drive_close", {"job": "Infosys"})
    assert_call(plan("show placement stats", TPO, "tpo"), "placement_stats", {})
    assert_call(plan("sync the job feed", TPO, "tpo"), "job_feed_sync", {})


# -- extractors ---------------------------------------------------------------------

@pytest.mark.parametrize("text,expected", [
    ("Schedule DBMS class tomorrow at 10am for 90 minutes in LT-2", "tomorrow at 10am"),
    ("schedule CS301 next monday 2:30 pm", "next monday 2:30 pm"),
    ("cancel tomorrow's DBMS class", "tomorrow"),
    ("schedule it on friday 10-11am", "friday 10am"),
    ("2026-11-25T10:00:00+05:30", "2026-11-25T10:00:00+05:30"),
    ("no time here", None),
])
def test_extract_when(text, expected):
    assert planner.extract_when(text) == expected


def test_extract_from_when():
    assert planner.extract_from_when("move the CS301 class from friday to monday 11am") == ("friday", "monday 11am")
    assert planner.extract_from_when("move CS301 to monday 11am") == (None, "monday 11am")


@pytest.mark.parametrize("text,expected", [
    ("for 90 minutes", 90), ("for 2 hours", 120), ("1 hr 30 min", 90), ("1h 30m", 90), ("half an hour", 30),
    ("an hour", 60), ("one and a half hours", 90), ("10-11am", 60), ("in 2 hours", None), ("for 5 minutes", None),
])
def test_extract_duration(text, expected):
    assert planner.extract_duration_minutes(text) == expected


def test_extract_room_course_and_more():
    assert planner.extract_room("in LT-2 please") == "LT-2"
    assert planner.extract_room("room 204") == "204"
    assert planner.extract_course("cs 301 tomorrow") == "CS301"
    assert planner.extract_course("attendance report for the Data Structures class") == "Data Structures"
    assert planner.extract_course("take attendance for this course", {"params": {"courseId": "c42"}}) == "c42"
    assert planner.extract_course("schedule a class tomorrow at 10") is None
    assert planner.extract_within("anything within 3 days?") == "within 3 days"
    assert planner.extract_days("classes next week") == 14
    assert planner.extract_days("next 3 days") == 3
    assert planner.extract_threshold("under 65") == 65
    assert planner.extract_join_code("code is k7m2qp") == "K7M2QP"
    assert planner.extract_join_code("join K7M2QP") == "K7M2QP"
    assert planner.extract_application_status("rejected or shortlisted ones") == "rejected"
    assert planner.extract_decision("decline it") == "reject"
    assert planner.extract_topic("schedule CS301 tomorrow 10am, topic: normalization") == "normalization"
