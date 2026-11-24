"""
Gemini-backed natural-language interpretation for the eligibility agent.

This is the ONLY place in the package that talks to an LLM, and it is
scoped narrowly on purpose: it turns a free-text query into the same
structured JSON shape a caller could otherwise send directly (see
agent.py's payload contract) -- nothing more.

The rule engine (rules_engine.py) and the anomaly/override detector
(anomaly_detector.py) stay 100% deterministic. Gemini never decides an
eligibility verdict and never invents an anomaly; it only extracts (or, for
details the query genuinely doesn't mention, estimates) the *inputs* those
deterministic checks run on. That split matters here specifically: this
feature exists to give students and auditors a trustworthy, reproducible
answer, and an LLM hallucinating the actual verdict would undermine that.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, Optional

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

_ENDPOINT = (
    f"https://generativelanguage.googleapis.com/v1beta/models/"
    f"{settings.GEMINI_MODEL}:generateContent?key={settings.GEMINI_API_KEY}"
)

# {query} is filled in at call time -- doubled braces below are literal
# braces in the JSON-shaped instructions.
_PROMPT_TEMPLATE = """You are the context-aware data-extraction layer in front of a deterministic student-placement eligibility engine. You never decide eligibility yourself -- you only convert the request and authoritative context into the structured input that engine runs on.

The CONTEXT can contain a saved student profile, the college's active jobs, and session state. Treat it as authoritative. Use values from CONTEXT before asking the user for them. Never ask for CGPA, branch, backlog count, job title, or job criteria when that value already exists in CONTEXT. A follow-up such as "8.2", "CSE", or "tell me about this job" belongs to the selected job and workflow recorded in the session context.

Given the query below from either a student or a TPO (placement office) staff member, decide which of three actions it is, and reply with ONE JSON object -- and nothing else -- in one of these three exact shapes.

Shape 1 -- a student asking whether/why they are eligible for a job, AND the query states enough to actually run the check (see ESSENTIAL FIELDS below):
{{
  "action": "check_eligibility",
  "student": {{
    "student_id": "short id, invent like S-1 if none given",
    "name": "name if given, else 'Not mentioned'",
    "branch": "branch/major, as stated",
    "cgpa": number between 0 and 10, as stated,
    "active_backlogs": integer >= 0, as stated,
    "tenth_percentage": number 0-100 or null if not mentioned,
    "twelfth_percentage": number 0-100 or null if not mentioned,
    "graduation_year": integer or null if not mentioned,
    "category": "General/OBC/SC/ST/EWS if stated, else 'General'",
    "experience_months": integer >= 0, 0 if not mentioned
  }},
  "criteria": {{
    "job_id": "short id, invent like J-1 if none given",
    "job_title": "the job/role name, as stated",
    "min_cgpa": number or null if not mentioned,
    "max_backlogs": integer or null if not mentioned,
    "allowed_branches": ["branch names mentioned as eligible, [] if unrestricted"],
    "excluded_branches": ["branch names explicitly excluded, [] if none"],
    "min_tenth_percentage": number or null if not mentioned,
    "min_twelfth_percentage": number or null if not mentioned,
    "allowed_graduation_years": [integers mentioned, [] if unrestricted],
    "allowed_categories": ["categories mentioned, [] if unrestricted"],
    "min_experience_months": integer or null if not mentioned,
    "max_experience_months": integer or null if not mentioned
  }}
}}

Shape 2 -- a TPO staff member asking to audit rule conflicts and/or override history, AND the query identifies at least one job posting or override to audit:
{{
  "action": "audit",
  "criteria_list": [ {{...same EligibilityCriteria shape as in Shape 1...}}, ... ],
  "overrides": [
    {{
      "job_id": "string",
      "student_id": "string",
      "tpo_staff_id": "string",
      "rule_engine_verdict": true or false,
      "override_verdict": true or false,
      "reason": "the reason given, or '' if none",
      "timestamp": "ISO-8601 datetime string"
    }}
  ]
}}

Shape 3 -- the query is missing information genuinely required to do Shape 1 or Shape 2 (see ESSENTIAL FIELDS below), or it's ambiguous which of the two the user wants:
{{
  "action": "clarify",
  "missing": ["short field names, from the ESSENTIAL FIELDS list below, that the query didn't state"],
  "message": "one short, natural, friendly question asking the user for exactly that missing information -- do not mention JSON, fields, schemas, or extraction"
}}

ESSENTIAL FIELDS -- never invent, guess, or default these; only their absence from BOTH the query and CONTEXT means Shape 3:
- For a check_eligibility request: use the selected or matching metadata job, plus the student's branch, CGPA, and active backlog count from CONTEXT whenever available. Ask only for values that are absent from both places.
- For an audit request: at least one job posting or override identified to audit ("job_title" or "job_id"). If the TPO didn't say which job(s), use Shape 3.

Everything NOT in the ESSENTIAL FIELDS list (10th/12th percentage, graduation year, category, experience, and every criteria.* field besides job_title) is optional -- leave it null/[] when not mentioned rather than asking for it or inventing it. An unset criterion simply means that rule isn't checked, which is a normal, valid outcome.

Rules:
- Use every concrete number, name, branch, or condition literally stated in the query -- never override or contradict what the user said.
- Never fabricate a value for an ESSENTIAL FIELD. If it's missing from both the query and CONTEXT, use Shape 3 -- do not fall back to a placeholder.
- CGPA must be numeric and between 0 and 10. If the query supplies an out-of-range value, return Shape 3 asking for a valid CGPA.
- For non-essential fields only, null/[]/"Not mentioned" is the correct value when the query doesn't mention them -- that is not a reason to use Shape 3.
- If the query is about auditing, overrides, anomalies, or a TPO review, evaluate against Shape 2's requirements. Otherwise evaluate against Shape 1's.
- Reply with ONLY the JSON object. No markdown code fences, no commentary before or after it.

CONTEXT:
{context}

CURRENT USER QUERY: "{query}"
"""


async def interpret_query(
    user_query: str,
    timeout: float = 15.0,
    *,
    metadata: Optional[Dict[str, Any]] = None,
    session_context: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """Ask Gemini, in real time, to turn a free-text query into a
    structured eligibility payload (the same shape `agent.py` accepts as
    an explicit JSON request).

    Returns the parsed dict on success. Returns None if the call failed or
    the response wasn't parseable JSON -- callers must surface that as a
    real error, not silently fall back to canned data.
    """
    context = json.dumps(
        {"metadata": metadata or {}, "session": session_context or {}},
        default=str,
        ensure_ascii=True,
    )
    prompt = _PROMPT_TEMPLATE.format(query=user_query.replace('"', "'"), context=context)
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"response_mime_type": "application/json"},
    }

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(_ENDPOINT, json=payload)

            if response.status_code != 200:
                logger.warning(
                    "Gemini eligibility extraction failed: HTTP %s -- %s",
                    response.status_code, response.text[:300],
                )
                return None

            data = response.json()
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            # Strip markdown fences defensively, in case the model adds them
            # despite the JSON response_mime_type / prompt instruction.
            text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.MULTILINE).strip()

            parsed = json.loads(text)
            if not isinstance(parsed, dict) or "action" not in parsed:
                logger.warning("Gemini eligibility extraction returned an unexpected shape: %r", parsed)
                return None
            return parsed

    except Exception:
        logger.exception("Gemini eligibility extraction errored")
        return None
