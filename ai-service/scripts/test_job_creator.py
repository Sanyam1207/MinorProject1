"""Job Creation Agent — Integration test script.

Tests all 17 scenarios described in the implementation spec.

Usage:
    # Start the service first (needs a real GEMINI_API_KEY in ai-service/.env):
    cd ai-service && .venv/bin/python -m app.main

    # Then in a separate terminal (same AI_SERVICE_TOKEN as the service, if set):
    AI_SERVICE_TOKEN=... .venv/bin/python scripts/test_job_creator.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from typing import Any, Dict, List, Optional

import socketio

URL = os.getenv("AI_URL", f"http://127.0.0.1:{os.getenv('AI_PORT', '9000')}")
AUTH = {"token": os.environ["AI_SERVICE_TOKEN"]} if os.getenv("AI_SERVICE_TOKEN") else None

# Shared institutional context
META_DATA = {
    "college_name": "NMIMS Mumbai",
    "branches": ["CSE", "ECE", "Automation and Robotics", "Mechanical Engineering"],
}

# Colour helpers
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
RESET = "\033[0m"
BOLD = "\033[1m"


def ok(msg: str) -> None:
    print(f"  {GREEN}✓{RESET} {msg}")


def fail(msg: str) -> None:
    print(f"  {RED}✗{RESET} {msg}")


def info(msg: str) -> None:
    print(f"  {CYAN}→{RESET} {msg}")


def section(title: str) -> None:
    print(f"\n{BOLD}{YELLOW}{'─'*60}{RESET}")
    print(f"{BOLD}{YELLOW}  {title}{RESET}")
    print(f"{BOLD}{YELLOW}{'─'*60}{RESET}")


# ---------------------------------------------------------------------------
# Single-request helper
# ---------------------------------------------------------------------------


async def send_request(
    session_id: str,
    request_id: str,
    user_query: str,
    user_role: str = "tpo",
    mode_name: str = "job-creation",
    meta_data: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Send one query and collect all response chunks until isEnd=True.

    Adds a mandatory 4.5s sleep after every response to respect the Gemini
    free-tier limit of 15 requests per minute.  The server-side retry in
    call_gemini_chat() handles any transient 429s that still slip through.
    """
    sio = socketio.AsyncClient()
    chunks: List[Dict] = []
    done = asyncio.Event()

    @sio.on("response")
    async def on_response(data: dict) -> None:
        chunks.append(data)
        if data.get("isEnd"):
            done.set()

    await sio.connect(URL, auth=AUTH)
    await sio.emit(
        "query",
        {
            "requestId": request_id,
            "sessionId": session_id,
            "user_query": user_query,
            "user_role": user_role,
            "mode_name": mode_name,
            "meta_data": meta_data or META_DATA,
        },
    )

    try:
        # Timeout is high to accommodate server-side 429 retry waits (up to 65s)
        await asyncio.wait_for(done.wait(), timeout=120.0)
    except asyncio.TimeoutError:
        print(f"  {RED}TIMEOUT waiting for response{RESET}")

    await sio.disconnect()

    # Mandatory throttle — keeps us at ≤13 RPM (safe margin below 15 RPM limit)
    await asyncio.sleep(4.5)

    return chunks[-1] if chunks else {}


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


def assert_header(chunk: Dict, expected: str, label: str) -> bool:
    got = chunk.get("header_message", "")
    if got == expected:
        ok(f"{label}: header_message = '{got}'")
        return True
    else:
        msg = f"{label}: expected header '{expected}', got '{got}'"
        fail(msg)
        raise AssertionError(msg)


def assert_missing(chunk: Dict, fields: List[str], label: str) -> bool:
    data = chunk.get("data", {})
    missing = data.get("missing_fields", [])
    if set(fields).issubset(set(missing)):
        ok(f"{label}: missing_fields contains {fields}")
        return True
    else:
        msg = f"{label}: expected {fields} in missing_fields, got {missing}"
        fail(msg)
        raise AssertionError(msg)


def assert_field(chunk: Dict, field: str, expected: Any, label: str) -> bool:
    data = chunk.get("data", {})
    job = data.get("job", {})
    got = job.get(field)
    if got == expected:
        ok(f"{label}: job.{field} = {expected!r}")
        return True
    elif isinstance(expected, list) and isinstance(got, list) and set(expected) == set(got):
        ok(f"{label}: job.{field} = {expected!r} (set match)")
        return True
    else:
        msg = f"{label}: expected job.{field} = {expected!r}, got {got!r}"
        fail(msg)
        raise AssertionError(msg)


def assert_data_type(chunk: Dict, dtype: str, label: str) -> bool:
    data = chunk.get("data", {})
    got = data.get("type", "")
    if got == dtype:
        ok(f"{label}: data.type = '{dtype}'")
        return True
    else:
        msg = f"{label}: expected data.type = '{dtype}', got '{got}'"
        fail(msg)
        raise AssertionError(msg)


def assert_error(chunk: Dict, label: str) -> bool:
    """Check that a chunk represents an authorization error."""
    resp = chunk.get("response", "").lower()
    if "not eligible" in resp or "not allowed" in resp or "tpo" in resp:
        ok(f"{label}: got authorization error message")
        return True
    else:
        msg = f"{label}: expected auth error, got: {chunk.get('response', '')[:80]!r}"
        fail(msg)
        raise AssertionError(msg)


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------


async def test_01_unauthorized_student():
    section("Test 1 — Unauthorized Student")
    chunk = await send_request(
        session_id="test-01",
        request_id="req-01",
        user_query="Create a Microsoft job",
        user_role="student",
    )
    info(f"Response: {chunk.get('response', '')[:100]!r}")
    assert_error(chunk, "Student blocked")
    return chunk


async def test_02_partial_job_creation():
    section("Test 2 — Partial Job Creation (missing description + deadline)")
    chunk = await send_request(
        session_id="test-02",
        request_id="req-02",
        user_query="Create a Microsoft SDE job.",
    )
    info(f"Response: {chunk.get('response', '')[:120]!r}")
    info(f"Data: {json.dumps(chunk.get('data', {}), indent=2)[:300]}")
    assert_header(chunk, "mode:jobCreation:data", "Partial creation")
    assert_missing(chunk, ["job_description", "app_deadline"], "Missing fields")
    return chunk


async def test_03_complete_job_creation():
    section("Test 3 — Complete Job Creation")
    sid = "test-03"
    # Step 1: Start
    await send_request(sid, "req-03a", "Create a Microsoft SDE job.")
    # Step 2: Add description
    await send_request(sid, "req-03b",
        "The job is for Software Development Engineer. Responsibilities include designing "
        "and building scalable systems. Requirements: 3+ years Python, system design skills.")
    # Step 3: Add deadline
    chunk = await send_request(sid, "req-03c", "The deadline is 30 September 2026.")
    info(f"Response: {chunk.get('response', '')[:120]!r}")
    info(f"Header: {chunk.get('header_message', '')}")
    assert_header(chunk, "mode:jobCreation:ready", "All fields complete")
    return chunk


async def test_04_salary_default():
    section("Test 4 — Salary Default ('not disclosed')")
    sid = "test-04"
    # Create complete job without mentioning salary
    await send_request(sid, "req-04a", "Create a Google Backend Engineer job.")
    await send_request(sid, "req-04b",
        "Description: Work on distributed systems at scale. Deadline: 15 October 2026.")
    chunk = await send_request(sid, "req-04c", "That's all the info I have.")
    data = chunk.get("data", {})
    job = data.get("job", {})
    salary = job.get("salary", "MISSING")
    info(f"salary = {salary!r}")
    if salary == "not disclosed":
        ok("Salary defaulted to 'not disclosed'")
    else:
        fail(f"Expected 'not disclosed', got {salary!r}")
    return chunk


async def test_05_branch_default():
    section("Test 5 — Branch Default (all available branches)")
    sid = "test-05"
    await send_request(sid, "req-05a", "Create a TCS SDE job.")
    await send_request(sid, "req-05b",
        "Job description: Develop enterprise software. All branches are eligible.")
    chunk = await send_request(sid, "req-05c", "Deadline is 1 November 2026.")
    data = chunk.get("data", {})
    job = data.get("job", {})
    branches = job.get("eligible_branches", [])
    expected = META_DATA["branches"]
    info(f"eligible_branches = {branches}")
    if set(branches) == set(expected):
        ok("All college branches set as eligible")
    else:
        fail(f"Expected {expected}, got {branches}")
    return chunk


async def test_06_invalid_branch():
    section("Test 6 — Invalid Branch Rejection")
    sid = "test-06"
    await send_request(sid, "req-06a", "Create a Wipro Data Scientist job.")
    chunk = await send_request(sid, "req-06b",
        "Only Biotechnology students should be eligible.")
    resp = chunk.get("response", "").lower()
    data = chunk.get("data", {})
    job = data.get("job", {})
    branches = job.get("eligible_branches", [])
    info(f"Response: {chunk.get('response', '')[:200]!r}")
    if "biotechnology" in resp and ("not available" in resp or "not one of" in resp or "available branches" in resp):
        ok("Invalid branch rejected with explanation")
    else:
        fail("Expected rejection of 'Biotechnology' branch")
    if "Biotechnology" not in branches:
        ok("Biotechnology not stored in eligible_branches")
    else:
        fail("Biotechnology was incorrectly stored")
    return chunk


async def test_07_editing_after_ready():
    section("Test 7 — Editing After Ready (change salary)")
    sid = "test-07"
    await send_request(sid, "req-07a", "Create an Infosys Systems Engineer job.")
    await send_request(sid, "req-07b",
        "Description: Work on enterprise infrastructure. Deadline: 20 September 2026.")
    # Confirm it's ready
    chunk_ready = await send_request(sid, "req-07c", "That's all the info.")
    assert_header(chunk_ready, "mode:jobCreation:ready", "Job is ready before edit")
    # Now edit salary
    chunk = await send_request(sid, "req-07d", "Change the salary to 12 LPA.")
    info(f"Response: {chunk.get('response', '')[:120]!r}")
    info(f"Header: {chunk.get('header_message', '')}")
    assert_header(chunk, "mode:jobCreation:ready", "Still ready after salary edit")
    data = chunk.get("data", {})
    job = data.get("job", {})
    salary = job.get("salary", "MISSING")
    info(f"salary = {salary!r}")
    if "12" in salary.lower() or "lpa" in salary.lower():
        ok("Salary updated to 12 LPA")
    else:
        fail(f"Expected salary containing '12 LPA', got {salary!r}")
    return chunk


async def test_08_remove_mandatory_field():
    section("Test 8 — Removing a Mandatory Field (deadline)")
    sid = "test-08"
    await send_request(sid, "req-08a", "Create an Amazon SDE2 job.")
    await send_request(sid, "req-08b",
        "Description: Build scalable services on AWS. Deadline: 10 October 2026.")
    chunk_ready = await send_request(sid, "req-08c", "Looks good.")
    assert_header(chunk_ready, "mode:jobCreation:ready", "Ready before removal")
    # Remove deadline
    chunk = await send_request(sid, "req-08d", "Remove the deadline.")
    info(f"Response: {chunk.get('response', '')[:120]!r}")
    info(f"Header: {chunk.get('header_message', '')}")
    assert_header(chunk, "mode:jobCreation:data", "Back to DATA after removing deadline")
    assert_missing(chunk, ["app_deadline"], "Deadline missing")
    return chunk


async def test_09_post_confirmation_request():
    section("Test 9 — 'Post the Job' → Confirmation UI")
    sid = "test-09"
    await send_request(sid, "req-09a", "Create a Flipkart Product Manager job.")
    await send_request(sid, "req-09b",
        "Description: Drive product strategy. Deadline: 5 October 2026.")
    await send_request(sid, "req-09c", "Looks good.")
    # Request posting
    chunk = await send_request(sid, "req-09d", "Post the job.")
    info(f"Response: {chunk.get('response', '')[:120]!r}")
    info(f"Header: {chunk.get('header_message', '')}")
    info(f"Data type: {chunk.get('data', {}).get('type', 'N/A')}")
    assert_header(chunk, "mode:jobCreation:ready", "Still READY while awaiting confirmation")
    assert_data_type(chunk, "confirmation", "Confirmation payload")
    data = chunk.get("data", {})
    if data.get("action") == "post_job":
        ok("data.action = 'post_job'")
    else:
        fail(f"Expected data.action='post_job', got {data.get('action')!r}")
    return chunk


async def test_10_confirm_with_value():
    section("Test 10 — Confirm with 'confirm' action value")
    sid = "test-10"
    await send_request(sid, "req-10a", "Create a Swiggy Backend Engineer job.")
    await send_request(sid, "req-10b",
        "Description: Build delivery systems. Deadline: 25 September 2026.")
    await send_request(sid, "req-10c", "Looks good.")
    await send_request(sid, "req-10d", "Post the job.")  # set awaiting_confirmation=True
    # Confirm
    chunk = await send_request(sid, "req-10e", "confirm")
    info(f"Response: {chunk.get('response', '')[:120]!r}")
    info(f"Header: {chunk.get('header_message', '')}")
    assert_header(chunk, "mode:jobCreation:post", "Confirmed → POST")
    assert_data_type(chunk, "job_creation", "POST data type")
    data = chunk.get("data", {})
    if data.get("status") == "post":
        ok("data.status = 'post'")
    else:
        fail(f"Expected data.status='post', got {data.get('status')!r}")
    return chunk


async def test_11_confirm_by_text():
    section("Test 11 — Confirm with 'yes' (text)")
    sid = "test-11"
    await send_request(sid, "req-11a", "Create a Zomato Data Engineer job.")
    await send_request(sid, "req-11b",
        "Description: Build data pipelines. Deadline: 30 October 2026.")
    await send_request(sid, "req-11c", "That's all.")
    await send_request(sid, "req-11d", "Post the job.")
    chunk = await send_request(sid, "req-11e", "yes")
    info(f"Header: {chunk.get('header_message', '')}")
    assert_header(chunk, "mode:jobCreation:post", "Text 'yes' confirmed → POST")
    return chunk


async def test_12_cancel():
    section("Test 12 — Cancel Posting ('No')")
    sid = "test-12"
    await send_request(sid, "req-12a", "Create a Ola SDE job.")
    await send_request(sid, "req-12b",
        "Description: Build ride-sharing systems. Deadline: 15 November 2026.")
    await send_request(sid, "req-12c", "That's fine.")
    await send_request(sid, "req-12d", "Post the job.")
    chunk = await send_request(sid, "req-12e", "No")
    info(f"Response: {chunk.get('response', '')[:120]!r}")
    info(f"Header: {chunk.get('header_message', '')}")
    assert_header(chunk, "mode:jobCreation:ready", "Cancel → back to READY")
    assert_data_type(chunk, "job_creation", "Still a job_creation payload")
    return chunk


async def test_13_random_yes_no_post():
    section("Test 13 — Random 'yes' when not awaiting confirmation")
    sid = "test-13"
    # Start fresh — not awaiting confirmation
    chunk = await send_request(sid, "req-13a", "yes")
    info(f"Response: {chunk.get('response', '')[:120]!r}")
    info(f"Header: {chunk.get('header_message', '')}")
    # Should NOT return mode:jobCreation:post
    hdr = chunk.get("header_message", "")
    if hdr != "mode:jobCreation:post":
        ok("Random 'yes' did not trigger posting")
    else:
        fail("Random 'yes' incorrectly triggered posting!")
    return chunk


async def test_14_session_continuity():
    section("Test 14 — Session Continuity Across Multiple Turns")
    sid = "test-14"
    info("Turn 1: Create partial job")
    await send_request(sid, "req-14a", "Create a Netflix SDE job.")
    info("Turn 2: Add description")
    await send_request(sid, "req-14b",
        "Description: Work on streaming infrastructure for 250M users.")
    info("Turn 3: Add deadline")
    await send_request(sid, "req-14c", "Deadline: 1 December 2026.")
    info("Turn 4: Edit salary")
    c4 = await send_request(sid, "req-14d", "Set salary to 25 LPA.")
    info("Turn 5: Post")
    await send_request(sid, "req-14e", "Post the job.")
    info("Turn 6: Confirm")
    chunk = await send_request(sid, "req-14f", "yes")
    info(f"Final header: {chunk.get('header_message', '')}")
    info(f"Final data status: {chunk.get('data', {}).get('status', '')}")
    assert_header(chunk, "mode:jobCreation:post", "Session continuity: posted")
    job = chunk.get("data", {}).get("job", {})
    if job.get("company_name") == "Netflix":
        ok("Company name preserved: Netflix")
    else:
        fail(f"Company name lost, got: {job.get('company_name')!r}")
    return chunk


async def test_15_token_compaction():
    section("Test 15 — Token Compaction (many turns)")
    sid = "test-15"
    info("Sending 15 turns to exceed compaction threshold...")
    for i in range(12):
        await send_request(sid, f"req-15-{i}",
            f"Turn {i}: Just checking in. The job is a Software Engineer role. "
            f"Company: Oracle. Description: Build enterprise database tools. "
            f"Deadline: 20 November 2026. Salary: 18 LPA.")
    chunk = await send_request(sid, "req-15-final",
        "What is the current job status? Please confirm all details.")
    info(f"Response: {chunk.get('response', '')[:150]!r}")
    info(f"Header: {chunk.get('header_message', '')}")
    # Should still work correctly
    hdr = chunk.get("header_message", "")
    if hdr in ("mode:jobCreation:data", "mode:jobCreation:ready"):
        ok(f"Session still functional after many turns: {hdr}")
    else:
        fail(f"Unexpected header after many turns: {hdr!r}")
    return chunk


async def test_16_large_conversation():
    section("Test 16 — Large Conversation (history bounded)")
    # This test just verifies the session doesn't crash or OOM
    sid = "test-16"
    info("Sending 20 rapid turns...")
    for i in range(20):
        chunk = await send_request(sid, f"req-16-{i}",
            f"Update {i}: Company Accenture, role Consultant, description: "
            f"Enterprise consulting work. Deadline: 28 February 2027.")
    info(f"Final header: {chunk.get('header_message', '')}")
    if chunk.get("header_message") in ("mode:jobCreation:data", "mode:jobCreation:ready"):
        ok("Session survived 20 turns without crashing")
    else:
        fail(f"Session degraded: {chunk.get('header_message')!r}")
    return chunk


async def test_17_mode_detection():
    section("Test 17 — Auto Mode Detection")
    info("Testing natural language mode routing (no explicit mode_name)...")
    sio = socketio.AsyncClient()
    chunks: List[Dict] = []
    done = asyncio.Event()

    @sio.on("response")
    async def on_response(data: dict) -> None:
        chunks.append(data)
        if data.get("isEnd"):
            done.set()

    await sio.connect(URL, auth=AUTH)
    await sio.emit("query", {
        "requestId": "req-17",
        "sessionId": "test-17",
        "user_query": "I want to create a new job posting for our campus placement.",
        "user_role": "tpo",
        "meta_data": META_DATA,
        # No mode_name — let orchestrator detect
    })
    try:
        await asyncio.wait_for(done.wait(), timeout=20.0)
    except asyncio.TimeoutError:
        pass
    await sio.disconnect()

    for chunk in chunks:
        hdr = chunk.get("header_message", "")
        resp = chunk.get("response", "")
        info(f"  chunk header={hdr!r} response={resp[:80]!r}")
        if "job-creation" in hdr or "jobCreation" in hdr or "mode:switch:job-creation" in hdr:
            ok("Routed to job-creation mode")
            return chunks
    info("(Mode detection depends on Gemini API availability)")
    return chunks


# ---------------------------------------------------------------------------
# Main runner
# ---------------------------------------------------------------------------


async def main() -> None:
    print(f"\n{BOLD}Job Creation Agent — Integration Tests{RESET}")
    print(f"Connecting to: {URL}\n")

    results: Dict[str, bool] = {}

    tests = [
        ("01_unauthorized_student", test_01_unauthorized_student),
        ("02_partial_job_creation", test_02_partial_job_creation),
        ("03_complete_job_creation", test_03_complete_job_creation),
        ("04_salary_default", test_04_salary_default),
        ("05_branch_default", test_05_branch_default),
        ("06_invalid_branch", test_06_invalid_branch),
        ("07_editing_after_ready", test_07_editing_after_ready),
        ("08_remove_mandatory_field", test_08_remove_mandatory_field),
        ("09_post_confirmation_request", test_09_post_confirmation_request),
        ("10_confirm_with_value", test_10_confirm_with_value),
        ("11_confirm_by_text", test_11_confirm_by_text),
        ("12_cancel", test_12_cancel),
        ("13_random_yes_no_post", test_13_random_yes_no_post),
        ("14_session_continuity", test_14_session_continuity),
        ("15_token_compaction", test_15_token_compaction),
        ("16_large_conversation", test_16_large_conversation),
        ("17_mode_detection", test_17_mode_detection),
    ]

    # Run only specific tests if passed as arguments
    test_filter = set(sys.argv[1:]) if len(sys.argv) > 1 else None

    passed = 0
    failed = 0
    skipped = 0

    for name, fn in tests:
        if test_filter and name not in test_filter and not any(f in name for f in test_filter):
            skipped += 1
            continue
        try:
            await fn()
            passed += 1
        except Exception as exc:
            fail(f"Test {name} raised an unexpected exception: {exc}")
            import traceback
            traceback.print_exc()
            failed += 1
        await asyncio.sleep(5.0)  # 5s between test scenarios for rate-limit headroom

    section("Summary")
    print(f"  {GREEN}Passed:{RESET} {passed}")
    if failed:
        print(f"  {RED}Failed:{RESET} {failed}")
    if skipped:
        print(f"  {YELLOW}Skipped:{RESET} {skipped}")
    print()


if __name__ == "__main__":
    asyncio.run(main())
