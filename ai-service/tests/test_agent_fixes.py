"""Fixes in existing agents (PYTHON.md §6): job-creation, eligibility, stores."""

import pytest

from fakes import FakeSio, make_req
from app import orchestrator
from app.agents.job_creator import session as job_session
from app.agents.job_creator.agent import JobCreationAgent, _user_wants_to_post
from app.agents.job_creator.schemas import JobCreationChunk, JobData, JobStatus
from app.agents.job_creator.validator import is_cancellation_intent, is_confirmation_intent
from app.agents.job_eligibility.session import get_or_create_session as eligibility_session
from app.agents.pr_outreach.agent import MAX_HISTORY_ENTRIES, _OutreachSession
from app.utils.ttl_store import TTLStore

SID = "u1:s1"


# -- job creation: deterministic confirmation -------------------------------------

@pytest.mark.parametrize("text", ["yes", "Yes, post it", "post it", "go ahead!", "confirm", "ok do it", "submit"])
def test_confirmation_intents(text):
    assert is_confirmation_intent(text) is True
    assert is_cancellation_intent(text) is False


@pytest.mark.parametrize("text", ["no", "don't post", "not yet", "cancel", "never mind", "hold on"])
def test_cancellation_intents(text):
    assert is_cancellation_intent(text) is True
    assert is_confirmation_intent(text) is False


@pytest.mark.parametrize("text", [
    "make sure the cgpa is 7", "can you ensure salary is 10 LPA", "yesterday", "Nokia",
    "yes but change the deadline", "I don't know",
])
def test_substrings_never_confirm(text):
    assert is_confirmation_intent(text) is False
    assert is_cancellation_intent(text) is False


def test_post_request_detection():
    assert _user_wants_to_post("please post it now") is True
    assert _user_wants_to_post("make it live") is True
    assert _user_wants_to_post("don't post it yet") is False
    assert _user_wants_to_post("the position is open") is False


def _ready_session() -> job_session.JobSessionState:
    session = job_session.get_or_create_session(SID)
    session.job = JobData(
        company_name="Acme", job_role="SDE", job_description="Build things.",
        app_deadline="2099-12-31T23:59:59+05:30",
    )
    session.status = JobStatus.READY
    session.awaiting_confirmation = True
    return session


async def run(text, **kw):
    sio = FakeSio()
    await orchestrator.handle(make_req(text, **kw), sio, "sid")
    payloads = sio.payloads
    assert sum(1 for p in payloads if p.get("isEnd")) == 1 and payloads[-1]["isEnd"]
    return payloads


async def test_post_then_reset_then_no_repost():
    session = _ready_session()
    draft = session.draft_id
    payloads = await run("yes", role="tpo", mode_name="job-creation")
    post = payloads[-1]
    assert post["header_message"] == "mode:jobCreation:post"
    assert post["data"]["job"]["company_name"] == "Acme"
    assert post["data"]["draft_id"] == draft

    after = job_session.get_or_create_session(SID)
    assert after.job.company_name == "" and after.awaiting_confirmation is False
    assert after.status is JobStatus.DATA and after.history == []
    assert after.draft_id and after.draft_id != draft

    payloads = await run("post it", role="tpo", mode_name="job-creation", request_id="r2")
    assert "mode:jobCreation:post" not in [p["header_message"] for p in payloads]
    assert payloads[-1]["data"]["draft_id"] == after.draft_id


async def test_job_creation_errors_use_the_error_header():
    chunks = [chunk async for chunk in JobCreationAgent().run(make_req("post a job", role="student"))]
    assert [c.header_message for c in chunks] == ["mode:jobCreation:error"]
    assert JobCreationAgent.error_chunk("x").header_message == JobCreationChunk.HEADER_ERROR == "mode:jobCreation:error"


async def test_admin_may_create_jobs():
    chunks = [chunk async for chunk in JobCreationAgent().run(make_req("post a job for Acme", role="admin"))]
    assert chunks[-1].header_message != "mode:jobCreation:error"


# -- eligibility: trusted profile wins ------------------------------------------------

PROFILE = {"student_id": "stu-1", "name": "Test Student", "branch": "CSE", "cgpa": 7.0, "active_backlogs": 0,
           "graduation_year": 2026}
INFOSYS = {"_id": "j1", "title": "SDE Intern", "company_name": "Infosys", "minimumCgpa": 8.0}
TCS = {"_id": "j2", "title": "Analyst", "company_name": "TCS", "minimumCgpa": 6.0}


def results(payloads):
    final = payloads[-1]
    return [item for item in final["data"] if item.get("type") == "eligibility_result"]


async def test_typed_cgpa_is_a_what_if_not_the_verdict():
    payloads = await run("my cgpa is 9.9, am I eligible for Infosys", mode_name="job-eligibility",
                         profile=dict(PROFILE), jobs=[INFOSYS])
    [result] = results(payloads)
    assert result["isEligible"] is False and result["status"] == "ineligible"
    assert result["basis"] == "profile"
    assert result["what_if"] == {"isEligible": True, "values": {"cgpa": 9.9}}
    text = payloads[-1]["response"]
    assert "**What-if (not your official result):**" in text
    assert "CGPA 9.9" in text and "CGPA 7" in text and "Would be eligible" in text
    assert eligibility_session(SID).trusted_profile["cgpa"] == 7.0

    payloads = await run("am I eligible for Infosys", mode_name="job-eligibility", request_id="r2",
                         profile=dict(PROFILE), jobs=[INFOSYS])
    [result] = results(payloads)
    assert "what_if" not in result
    assert "What-if" not in payloads[-1]["response"]


async def test_self_reported_value_fills_a_gap():
    profile = {k: v for k, v in PROFILE.items() if k != "cgpa"}
    payloads = await run("am I eligible for Infosys", mode_name="job-eligibility", profile=profile, jobs=[INFOSYS])
    assert "CGPA" in payloads[-1]["response"]
    payloads = await run("8.2", mode_name="job-eligibility", request_id="r2", profile=profile, jobs=[INFOSYS])
    [result] = results(payloads)
    assert result["basis"] == "self_reported" and result["isEligible"] is True
    assert "typed by you and are not on your profile yet (cgpa)" in payloads[-1]["response"]


async def test_fresh_metadata_replaces_profile_and_jobs():
    await run("am I eligible for Infosys", mode_name="job-eligibility", profile=dict(PROFILE), jobs=[INFOSYS, TCS])
    assert set(eligibility_session(SID).jobs_by_id) == {"j1", "j2"}
    payloads = await run("am I eligible for Infosys", mode_name="job-eligibility", request_id="r2",
                         profile={**PROFILE, "cgpa": 8.5}, jobs=[INFOSYS])
    state = eligibility_session(SID)
    assert state.trusted_profile["cgpa"] == 8.5
    assert set(state.jobs_by_id) == {"j1"}
    [result] = results(payloads)
    assert result["isEligible"] is True


async def test_staff_entries_are_marked_entered():
    payloads = await run("check eligibility: cgpa is 8.6 for Infosys", role="tpo", mode_name="job-eligibility",
                         profile={"name": "Officer"}, jobs=[INFOSYS])
    [result] = results(payloads)
    assert result["basis"] == "entered" and result["isEligible"] is True


async def test_details_carry_the_selected_job():
    await run("am I eligible for Infosys", mode_name="job-eligibility", profile=dict(PROFILE), jobs=[INFOSYS])
    payloads = await run("tell me about this job", mode_name="job-eligibility", request_id="r2",
                         profile=dict(PROFILE), jobs=[INFOSYS])
    details = [p for p in payloads if p["header_message"] == "mode:jobparser:jobdetails" and isinstance(p["data"], dict)]
    assert details and details[0]["data"]["selected_job"]["job_id"] == "j1"


# -- TTL stores ---------------------------------------------------------------------

def test_ttl_store_expiry_cap_and_refresh():
    now = [0.0]
    store = TTLStore("test", ttl_seconds=10, max_items=2, clock=lambda: now[0])
    store.set("a", 1)
    now[0] = 5
    store.set("b", 2)
    now[0] = 9
    assert store.get("a") == 1           # refreshes a (last access 9)
    now[0] = 16
    assert store.get("b") is None        # b expired (last access 5, ttl 10)
    assert "a" in store
    store.set("c", 3)
    store.set("d", 4)                    # cap 2 -> least recently used (a) evicted
    assert store.get("a") is None and len(store) == 2
    assert store.get_or_create("", lambda: "x") == "x" and store.get(None) == "x"  # empty key -> "default"
    now[0] = 100
    assert store.prune() == 2
    assert store.pop("missing", "fallback") == "fallback"


def test_agent_stores_are_bounded():
    from app.agents.alumni_connect import agent as alumni
    from app.agents.pr_outreach import agent as outreach
    from app.agents.resume_generator import session as resume_session

    for store in (job_session._SESSIONS, resume_session._SESSIONS, outreach._sessions, alumni._sessions):
        assert isinstance(store, TTLStore)
    session = _OutreachSession()
    for index in range(MAX_HISTORY_ENTRIES + 10):
        session.append("user" if index % 2 == 0 else "model", f"turn {index}")
    assert len(session.history) == MAX_HISTORY_ENTRIES
    assert session.history[0]["role"] == "user"
