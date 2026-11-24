"""Jobs-finder wishlist / applied through the Node tracker tools (JOB-FEED.md §12.8, §16.2 item 7)."""

import copy

import pytest

from fakes import FakeSio, make_req
from test_jobs_finder_search import CAMPUS, MARKET, FakeExecute, ok_jobs
from app import orchestrator
from app.agents.jobscrapper import job_finder
from app.agents.jobscrapper.models.job import Job
from app.agents.jobscrapper.search import crawl_item
from app.agents.jobscrapper.session_store import session_job_store

SID = "u1:s1"
WISHLIST = "mode:jobparser:addjob:wishlist"
SAVE_OK = {
    "ok": True, "tool": "market_job_save",
    "summary": "Saved “Data Analyst Intern” at Northwind Analytics to your job tracker.",
    "data": {"item": {"status": "saved"}, "created": True},
    "ui": {"panel": "jobs.tracker", "params": {"highlightId": MARKET["id"]}},
}
APPLIED_OK = {
    "ok": True, "tool": "market_job_mark_applied",
    "summary": "Marked “Data Analyst Intern” at Northwind Analytics as applied on 25 Nov. Good luck!",
    "data": {"item": {"status": "applied"}, "created": False, "previousStatus": "saved"},
    "ui": {"panel": "jobs.tracker", "params": {"status": "applied", "highlightId": MARKET["id"]}},
}


@pytest.fixture
def fake(monkeypatch):
    execute = FakeExecute({
        "jobs_search_campus": ok_jobs([CAMPUS]),
        "jobs_search_market": ok_jobs([MARKET]),
        "market_job_save": SAVE_OK,
        "market_job_mark_applied": APPLIED_OK,
    })
    monkeypatch.setattr(job_finder, "execute_tool", execute)
    return execute


async def run(text, request_id="r1", **kw):
    sio = FakeSio()
    await orchestrator.handle(make_req(text, mode_name="jobs-finder", request_id=request_id, **kw), sio, "sid")
    payloads = sio.payloads
    assert sum(1 for p in payloads if p.get("isEnd")) == 1 and payloads[-1]["isEnd"] is True
    return payloads


def wishlist_result(payloads):
    [chunk] = [p for p in payloads if isinstance(p.get("data"), dict) and p["data"].get("type") == "wishlist"]
    assert chunk["header_message"] == WISHLIST
    assert payloads[-1]["header_message"] == WISHLIST and payloads[-1]["data"] == []
    return chunk


async def test_save_the_second_job(fake):
    await run("find data analyst internships")
    payloads = await run("add the 2nd job to my wishlist", request_id="r2")
    chunk = wishlist_result(payloads)
    assert fake.calls[-1] == ("market_job_save", {"job": MARKET["id"]})
    assert chunk["data"] == {
        "type": "wishlist", "action": "save", "ok": True, "job_id": MARKET["id"], "kind": "external",
        "status": "saved", "error": None, "ui": SAVE_OK["ui"],
    }
    assert chunk["response"] == SAVE_OK["summary"]
    assert session_job_store.get_jobs(SID)[1]["application_status"] == "saved"


async def test_campus_target_is_not_saved(fake):
    await run("find data analyst internships")
    calls = len(fake.calls)
    chunk = wishlist_result(await run("save job 1", request_id="r2"))
    assert len(fake.calls) == calls
    assert chunk["data"]["error"] == "CAMPUS_DRIVE" and chunk["data"]["ok"] is False
    assert "is a campus drive" in chunk["response"] and "apply to job 1" in chunk["response"]


async def test_crawl_target_is_not_saveable(fake):
    session_job_store.replace_jobs(SID, [crawl_item(Job(title="SRE", company="Fabrikam",
                                                        application_url="https://jobs.example.com/sre").model_dump())])
    chunk = wishlist_result(await run("save job 1"))
    assert fake.calls == []
    assert chunk["data"]["error"] == "NOT_SAVEABLE"


async def test_mark_applied(fake):
    session_job_store.replace_jobs(SID, [copy.deepcopy(job) for job in (
        job_finder.market_item(MARKET), job_finder.campus_item(CAMPUS))])
    chunk = wishlist_result(await run("mark job 1 as applied"))
    assert fake.calls == [("market_job_mark_applied", {"job": MARKET["id"]})]
    assert chunk["data"]["action"] == "applied" and chunk["data"]["status"] == "applied"


async def test_no_list_yet(fake):
    chunk = wishlist_result(await run("add the 2nd job to my wishlist"))
    assert chunk["data"]["error"] == "NO_JOBS"
    assert fake.calls == []


async def test_tracker_errors_are_explained(fake):
    await run("find data analyst internships")
    fake.responses["market_job_save"] = {"ok": False, "error": "FORBIDDEN", "message": "Students only."}
    chunk = wishlist_result(await run("add the 2nd job to my wishlist", request_id="r2"))
    assert chunk["data"]["error"] == "FORBIDDEN"
    assert chunk["response"] == "Only students have a job tracker."
    fake.responses["market_job_save"] = {"ok": False, "error": "UNAVAILABLE", "message": "timeout"}
    chunk = wishlist_result(await run("save job 2", request_id="r3"))
    assert chunk["response"] == "I couldn't reach your job tracker just now. Please try again."
