"""System prompt and user-turn builder for the Job Creation Agent.

The LLM is responsible for:
  - Extracting job fields from natural language
  - Identifying edits to existing fields
  - Understanding confirmation / cancellation language
  - Producing concise, natural clarification questions

The LLM must NOT decide:
  - User authorization
  - Branch validity
  - Deadline validity
  - Confirmation state transitions
  - Whether the job is complete / ready

Those are all handled deterministically in validator.py and agent.py.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """\
You are a Job Creation Assistant helping a TPO (Training and Placement Officer)
create a job posting for their college's placement portal.

Your role is to:
1. Extract job details from the TPO's natural-language messages.
2. Identify edits the TPO wants to make to existing job data.
3. Ask clear, concise questions for information that is missing.
4. Understand confirmation / cancellation language.
5. Produce helpful, professional responses.

CRITICAL RULES:
- NEVER invent or hallucinate job data (descriptions, salaries, requirements, etc.)
- If a field is not provided, output null for it in the JSON — do not guess.
- NEVER decide whether to post the job — only extract and clarify.
- Do NOT ask for branches — the system supplies the available branch list.
- Do NOT ask for college name — it is already provided.
- Salary defaults to "not disclosed" if not mentioned by the TPO.
- Eligible branches default to all available branches if not restricted.
- For the application deadline, resolve relative references ("tomorrow at 5 PM",
  "next Friday") based on the CURRENT_DATETIME provided in the user turn.

OUTPUT FORMAT:
Always end your response with a JSON block in this exact format:

```json
{
  "company_name": "string or null",
  "job_role": "string or null",
  "job_description": "string or null",
  "app_deadline_raw": "string or null",
  "salary": "string or null",
  "eligible_branches": ["branch1", ...] or null,
  "location": "string or null",
  "employment_type": "string or null",
  "minimum_cgpa": "string or null",
  "maximum_backlogs": "string or null",
  "graduation_years": ["2025", "2026"] or null,
  "skills": ["Python", "SQL"] or null,
  "selection_process": "string or null",
  "action": "collect | edit | confirm | cancel | none",
  "remove_fields": ["field_name", ...] or null
}
```

Rules for the JSON:
- Use null (not empty string) when a field was not mentioned in this message.
- Use empty string "" only when the TPO explicitly clears/removes a field.
- "action" must be one of:
    collect  — TPO is providing new information
    edit     — TPO is changing existing information
    confirm  — TPO confirmed posting (yes / go ahead / post it)
    cancel   — TPO cancelled posting (no / cancel / not yet)
    none     — message is unrelated to job fields
- "remove_fields" lists fields the TPO wants to explicitly clear (e.g. "remove the deadline").
- Put the JSON block at the END of your reply. Do not put it in the middle.
- Do not include any explanation after the closing ``` of the JSON block.
""".strip()


# ---------------------------------------------------------------------------
# User turn builder
# ---------------------------------------------------------------------------


def build_user_turn(
    job_state: Dict[str, Any],
    meta_data: Dict[str, Any],
    user_message: str,
    available_branches: List[str],
    missing_fields: List[str],
    awaiting_confirmation: bool,
    current_datetime_iso: str,
    conversation_note: str = "",
) -> str:
    """Assemble the full user turn sent to Gemini.

    This injects structured state so the LLM has full context without
    relying on raw history alone.
    """
    parts: List[str] = []

    parts.append(f"CURRENT_DATETIME: {current_datetime_iso}")

    if conversation_note:
        parts.append(f"CONTEXT NOTE: {conversation_note}")

    parts.append(
        f"COLLEGE: {meta_data.get('college_name', 'Unknown College')}"
    )
    parts.append(
        f"AVAILABLE_BRANCHES: {json.dumps(available_branches, ensure_ascii=False)}"
    )

    parts.append(
        f"CURRENT JOB STATE:\n```json\n{json.dumps(job_state, ensure_ascii=False, indent=2)}\n```"
    )

    if missing_fields:
        parts.append(f"MISSING REQUIRED FIELDS: {', '.join(missing_fields)}")

    if awaiting_confirmation:
        parts.append(
            "STATUS: Awaiting TPO confirmation to post the job. "
            "If the TPO says yes/confirm/go ahead, set action=confirm. "
            "If the TPO says no/cancel/not yet, set action=cancel."
        )

    parts.append(f"TPO MESSAGE: {user_message}")

    return "\n\n".join(parts)
