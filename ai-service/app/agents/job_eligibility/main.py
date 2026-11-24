"""
Self-tests + a runnable demo for the Job Eligibility package.

    python -m app.agents.job_eligibility

The self-tests and the structured-payload demo below never touch the
network -- they only exercise the deterministic rule engine and anomaly
detector. The natural-language path (agent.py's `_run_natural_language`,
backed by gemini_client.interpret_query) makes a real call to the Gemini
API and needs GEMINI_API_KEY / GEMINI_MODEL configured and network access;
it's demoed here with `interpret_query` monkeypatched so this file stays
runnable offline -- run the agent through the actual server for the real
end-to-end call.
"""

from __future__ import annotations

import asyncio
import json
from typing import List
from unittest.mock import patch

from app.schemas import QueryRequest
from app.agents.job_eligibility.models import AnomalyType, EligibilityCriteria, OverrideRecord, StudentProfile
from app.agents.job_eligibility.rules_engine import evaluate_eligibility
from app.agents.job_eligibility.anomaly_detector import detect_rule_conflicts, register_override
from app.agents.job_eligibility.agent import JobEligibilityAgent


def _self_test() -> None:
    """A handful of sanity checks on the rule engine and anomaly detector,
    run before the demo so a broken change fails loudly and immediately."""

    # An eligible student should have an all-pass, no-conflicts verdict.
    ok_criteria = EligibilityCriteria(job_id="J-1", job_title="Test Role", min_cgpa=7.0, max_backlogs=0)
    ok_student = StudentProfile(student_id="S-1", cgpa=8.0, active_backlogs=0)
    ok_verdict = evaluate_eligibility(ok_student, ok_criteria)
    assert ok_verdict.rule_engine_eligible is True
    assert detect_rule_conflicts(ok_criteria) == []

    # A student below the CGPA cut-off should fail on exactly that criterion.
    bad_student = StudentProfile(student_id="S-2", cgpa=6.0, active_backlogs=0)
    bad_verdict = evaluate_eligibility(bad_student, ok_criteria)
    assert bad_verdict.rule_engine_eligible is False
    assert any(r.criterion == "Minimum CGPA" and not r.passed for r in bad_verdict.criteria_results)

    # A rule-set with min_experience_months > max_experience_months is
    # unfillable and must be flagged.
    broken_criteria = EligibilityCriteria(
        job_id="J-2", min_experience_months=6, max_experience_months=3,
    )
    conflict_flags = detect_rule_conflicts(broken_criteria)
    assert any(f.type == AnomalyType.RULE_CONFLICT for f in conflict_flags)

    # An unreasoned override that contradicts the rule engine should raise
    # both OVERRIDE_WITHOUT_REASON and OVERRIDE_CONTRADICTS_RULES.
    log: List[OverrideRecord] = []
    flags = register_override(log, OverrideRecord(
        job_id="J-1", student_id="S-2", tpo_staff_id="tpo-1",
        rule_engine_verdict=False, override_verdict=True, reason="",
    ))
    types = {f.type for f in flags}
    assert AnomalyType.OVERRIDE_WITHOUT_REASON in types
    assert AnomalyType.OVERRIDE_CONTRADICTS_RULES in types

    print("All self-tests passed.\n")


async def _demo_structured_payloads() -> None:
    """Exercise the agent's explicit-JSON path -- no network involved."""
    agent = JobEligibilityAgent()

    check_payload = {
        "action": "check_eligibility",
        "student": {"student_id": "S-02", "name": "Rohan", "branch": "Mechanical",
                     "cgpa": 6.8, "active_backlogs": 1, "graduation_year": 2026},
        "criteria": {"job_id": "J-101", "job_title": "Graduate Software Engineer @ Acme Corp",
                     "min_cgpa": 7.5, "max_backlogs": 0, "allowed_branches": ["ECE", "CSE", "IT"]},
    }
    audit_payload = {
        "action": "audit",
        "criteria_list": [
            {"job_id": "J-102", "job_title": "Data Analyst Internship @ Beta Ltd",
             "min_experience_months": 6, "max_experience_months": 3},
        ],
        "overrides": [
            {"job_id": "J-101", "student_id": "S-02", "tpo_staff_id": "tpo-7",
             "rule_engine_verdict": False, "override_verdict": True, "reason": ""},
        ],
    }

    print("-- Structured payload: check_eligibility --\n")
    req = QueryRequest(requestId="local-test-1", sessionId="local-session", user_query=json.dumps(check_payload))
    async for chunk in agent.run(req):
        print(chunk, end="")

    print("\n-- Structured payload: audit --\n")
    req = QueryRequest(requestId="local-test-2", sessionId="local-session", user_query=json.dumps(audit_payload))
    async for chunk in agent.run(req):
        print(chunk, end="")


async def _demo_natural_language() -> None:
    """Exercise the free-text path with `interpret_query` mocked, so this
    stays runnable without network access or a real API key."""
    fake_extraction = {
        "action": "check_eligibility",
        "student": {"student_id": "S-42", "name": "Not mentioned", "branch": "CSE",
                     "cgpa": 6.5, "active_backlogs": 1, "graduation_year": 2026},
        "criteria": {"job_id": "J-1", "job_title": "SDE Intern @ Acme",
                     "min_cgpa": 7.0, "max_backlogs": 0},
    }

    print("\n-- Natural-language query (Gemini extraction mocked for this offline demo) --\n")
    with patch("app.agents.job_eligibility.agent.interpret_query", return_value=fake_extraction):
        agent = JobEligibilityAgent()
        req = QueryRequest(
            requestId="local-test-3", sessionId="local-session",
            user_query="I'm a CSE student, CGPA 6.5, one active backlog -- am I eligible for the SDE intern role at Acme (needs 7.0 CGPA, no backlogs)?",
        )
        async for chunk in agent.run(req):
            print(chunk, end="")
    print()


async def _demo() -> None:
    await _demo_structured_payloads()
    await _demo_natural_language()


if __name__ == "__main__":
    _self_test()
    asyncio.run(_demo())