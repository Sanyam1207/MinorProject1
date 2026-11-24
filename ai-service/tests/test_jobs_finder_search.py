"""Jobs-finder real search (JOB-FEED.md §12.4–§12.7, §16.2 items 1–6, 8, 9)."""

import copy

import pytest

from fakes import FakeSio, make_req
from app import orchestrator
from app.agents.jobscrapper import job_finder
from app.agents.jobscrapper.formatter import format_job_for_data
from app.agents.jobscrapper.models.job import Job
from app.agents.jobscrapper.search import ITEM_KEYS, extract_search_args
from app.agents.jobscrapper.session_store import session_job_store
from app.agents.modes import AgentMode
from app.llm import gemini
from app.orchestrator import route_query

SID = "u1:s1"

CAMPUS = {
    "id": "6743f0c2a1b2c3d4e5f60711", "_id": "6743f0c2a1b2c3d4e5f60711", "title": "Data Analyst Intern",
    "company": {"_id": "co1", "name": "Acme Corp"}, "companyName": "Acme Corp", "companyLogo": None,
    "salary": "₹30,000/month", "packageLpa": 3.6, "location": "Noida", "employmentType": "Internship",
    "skills": ["SQL", "Excel"], "description": "Analyse data.", "minimumCgpa": 7, "maximumBacklogs": 0,
    "eligibleBranches": ["CSE", "IT"], "graduationYears": [2026], "selectionProcess": ["Test", "Interview"],
    "applicationUrl": None, "createdAt": "2026-11-20T09:00:00.000Z", "applicationDeadline": "2026-12-01T18:29:59.000Z",
    "isEligible": True, "eligibilityReasons": [], "matchScore": 80, "matchedSkills": ["SQL"], "myApplication": None,
}
MARKET = {
    "id": "6743f0c2a1b2c3d4e5f60718", "title": "Data Analyst Intern", "company": "Northwind Analytics",
    "companyLogo": None, "location": "Gurugram", "jobType": "internship", "workType": "hybrid", "salary": None,
    "experience": "Freshers", "categories": ["data-analyst"], "description": "Dashboards.",
    "applyUrl": "https://example.com/jobs/123456", "postedAt": "2026-11-24T08:00:00.000Z",
    "sources": ["debugwithshubham", "whatsapp"], "isSample": False, "matchScore": 72,
    "matchedSkills": ["SQL", "Excel"], "saved": {"status": "saved"},
}


def market_job(job_id, title="Backend Engineer", company="Contoso"):
    job = copy.deepcopy(MARKET)
    job.update(id=job_id, title=title, company=company, saved=None)
    return job


class FakeExecute:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    async def __call__(self, meta_data, tool, args, *, confirmed=False, timeout=20.0, request_id=None):
        self.calls.append((tool, dict(args)))
        response = self.responses.get(tool, {"ok": False, "error": "UNKNOWN_TOOL", "message": "No such tool"})
        return copy.deepcopy(response(args) if callable(response) else response)


def ok_jobs(jobs):
    return {"ok": True, "summary": f"{len(jobs)} jobs", "data": {"jobs": jobs, "total": len(jobs)}}


@pytest.fixture
def gemini_forbidden(monkeypatch):
    calls = []

    async def refuse(*args, **kwargs):
        calls.append(kwargs)
        raise AssertionError("the jobs-finder search must not call Gemini")

    def refuse_stream(*args, **kwargs):
        calls.append(kwargs)
        raise AssertionError("the jobs-finder search must not call Gemini")

    for name in ("generate", "generate_json", "generate_text"):
        monkeypatch.setattr(gemini, name, refuse)
    monkeypatch.setattr(gemini, "stream_text", refuse_stream)
    return calls


def install(monkeypatch, responses):
    fake = FakeExecute(responses)
    monkeypatch.setattr(job_finder, "execute_tool", fake)
    return fake


async def run(text, **kw):
    sio = FakeSio()
    await orchestrator.handle(make_req(text, mode_name="jobs-finder", **kw), sio, "sid")
    payloads = sio.payloads
    assert sum(1 for p in payloads if p.get("isEnd")) == 1 and payloads[-1]["isEnd"] is True
    return payloads


async def test_search_streams_real_items(monkeypatch, gemini_forbidden):
    fake = install(monkeypatch, {"jobs_search_campus": ok_jobs([CAMPUS]), "jobs_search_market": ok_jobs([MARKET])})
    payloads = await run("find data analyst internships")
    final = payloads[-1]
    assert final["header_message"] == "mode:jobparser:jobslist"
    items = final["data"]
    assert [list(item) for item in items] == [list(ITEM_KEYS)] * 2
    assert [item["id"] for item in items] == [CAMPUS["id"], MARKET["id"]]
    assert items[0]["kind"] == "campus" and items[0]["isEligible"] is True
    assert items[0]["requirements"] == "Min CGPA 7 · Max backlogs 0 · Branches: CSE, IT · Batch 2026 · Test → Interview"
    assert items[1]["kind"] == "external" and items[1]["isEligible"] is None
    assert items[1]["application_status"] == "saved" and items[1]["saveable"] is True
    assert final["response"].startswith(
        "🔎 Searching campus drives and the open-market job feed for “data analyst” · internship…"
    )
    assert ("Hey there! I found 2 job(s) for you: 1 campus drive (1 you're eligible for) and 1 open-market listing, "
            "best matches first.") in final["response"]
    assert fake.calls == [
        ("jobs_search_campus", {"query": "data analyst", "limit": 6}),
        ("jobs_search_market", {"query": "data analyst", "jobType": "internship", "sort": "match", "limit": 12}),
    ]
    assert gemini_forbidden == []
    assert [job["id"] for job in session_job_store.get_jobs(SID)] == [CAMPUS["id"], MARKET["id"]]


@pytest.mark.parametrize("text,expected", [
    ("Can you help me find some Jobs", ("", None, None, None)),
    ("find me software jobs in Bangalore", ("software", None, None, "Bengaluru")),
    ("show remote data analyst internships", ("data analyst", "internship", "remote", None)),
    ("python developer roles in pune or bangalore", ("python developer", None, None, "Pune")),
    ("jobs at Infosys", ("infosys", None, None, None)),
])
def test_extract_search_args(text, expected):
    assert extract_search_args(text) == expected


async def test_without_tool_token_nothing_is_called(monkeypatch, gemini_forbidden):
    fake = install(monkeypatch, {})
    payloads = await run("find data analyst internships", with_tools=False)
    assert fake.calls == []
    assert payloads[-1]["data"] == []
    assert "AGENT_TOOL_SECRET is missing on the server" in payloads[-1]["response"]


async def test_campus_failure_shows_market_only(monkeypatch, gemini_forbidden):
    install(monkeypatch, {
        "jobs_search_campus": {"ok": False, "error": "UNAVAILABLE", "message": "campus service down"},
        "jobs_search_market": ok_jobs([MARKET]),
    })
    payloads = await run("find data analyst internships")
    final = payloads[-1]
    assert "⚠️ Campus drives are unavailable right now (campus service down); showing open-market jobs only." in final["response"]
    assert [item["id"] for item in final["data"]] == [MARKET["id"]]


async def test_both_failing_gives_an_error_and_no_items(monkeypatch, gemini_forbidden):
    install(monkeypatch, {
        "jobs_search_campus": {"ok": False, "error": "UNAVAILABLE", "message": "down"},
        "jobs_search_market": {"ok": False, "error": "UNAVAILABLE", "message": "feed down"},
    })
    payloads = await run("find data analyst internships")
    assert payloads[-1]["data"] == []
    assert "I couldn't reach the job database just now (feed down). Please try again in a moment." in payloads[-1]["response"]


async def test_zero_results_message(monkeypatch, gemini_forbidden):
    install(monkeypatch, {"jobs_search_campus": ok_jobs([]), "jobs_search_market": ok_jobs([])})
    payloads = await run("find quantum basket weaving jobs in Pune")
    assert payloads[-1]["data"] == []
    assert "I couldn't find any open roles matching “quantum basket weaving” · Pune right now." in payloads[-1]["response"]


async def test_staff_search_the_market_only(monkeypatch, gemini_forbidden):
    fake = install(monkeypatch, {"jobs_search_market": ok_jobs([MARKET])})
    payloads = await run("find data analyst jobs", role="tpo")
    assert [call[0] for call in fake.calls] == ["jobs_search_market"]
    assert fake.calls[0][1]["sort"] == "newest"
    assert payloads[-1]["data"][0]["isEligible"] is None
    assert "Hello Placement Team! I found 1 open-market listing(s)" in payloads[-1]["response"]


async def test_new_search_replaces_the_list(monkeypatch, gemini_forbidden):
    fake = install(monkeypatch, {"jobs_search_campus": ok_jobs([CAMPUS]), "jobs_search_market": ok_jobs([MARKET])})
    await run("find data analyst internships")
    fake.responses.update({
        "jobs_search_campus": ok_jobs([]),
        "jobs_search_market": ok_jobs([market_job("m-new-1"), market_job("m-new-2", "QA Engineer")]),
        "market_job_save": {"ok": True, "summary": "Saved “Backend Engineer” at Contoso to your job tracker.",
                            "data": {"item": {"status": "saved"}, "created": True},
                            "ui": {"panel": "jobs.tracker", "params": {"highlightId": "m-new-1"}}},
    })
    await run("find backend engineer jobs", request_id="r2")
    assert [job["id"] for job in session_job_store.get_jobs(SID)] == ["m-new-1", "m-new-2"]
    await run("save job 1", request_id="r3")
    assert fake.calls[-1] == ("market_job_save", {"job": "m-new-1"})


def test_routing_rules_survive():
    assert route_query("add the 2nd job to my wishlist") is AgentMode.JOBS
    assert route_query("post a job for Infosys") is AgentMode.JOB_CREATION


def test_format_job_for_data():
    crawled = format_job_for_data(Job(title="SRE", company="Fabrikam", application_url="https://jobs.example.com/sre").model_dump())
    assert crawled["id"].startswith("crawl:") and crawled["kind"] == "external"
    assert crawled["source"] == "crawl" and crawled["saveable"] is False
    assert list(crawled) == list(ITEM_KEYS)
    assert format_job_for_data(crawled) is crawled
