"""System prompts and user-turn builders for the AI Interviewer Agent.

The LLM is responsible for language work only:
  - extracting job details from a careers page
  - reading the candidate's name out of a free-text reply
  - writing the next question, given the transcript so far
  - scoring the finished transcript

The LLM does NOT decide:
  - which stage the session is in
  - whether the interview has run out of time
  - whether the candidate asked to stop

Those are handled deterministically in ``agent.py``, so a model that
misreads an answer can never, say, end the interview early or skip the
mandatory name step.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional


# ---------------------------------------------------------------------------
# 1. Job-description extraction (option 1)
# ---------------------------------------------------------------------------

SYSTEM_PROMPT_JD = """\
You extract structured job details from the text of a careers / job posting page.

Return ONE JSON object and nothing else, in exactly this shape:
{
  "job_title": "the role title, or 'Not mentioned'",
  "company": "the hiring company, or 'Not mentioned'",
  "experience_required": "e.g. '2-4 years', 'Entry level', 'Fresher', or 'Not mentioned'",
  "location": "city / country / Remote, or 'Not mentioned'",
  "employment_type": "Full-time / Internship / Contract, or 'Not mentioned'",
  "skills": ["concrete technologies and skills the posting names"],
  "responsibilities": ["what the person will actually do"],
  "qualifications": ["required qualifications and requirements"],
  "description": "2-4 sentence overview of the role"
}

Rules:
- Extract only what the page actually states. Never invent a company, a
  salary, or a skill that is not in the text.
- Use "Not mentioned" for any string field the page does not state, and []
  for any list the page does not state.
- Keep each list to at most 12 short entries.
"""


def build_jd_user_turn(page_text: str, source_url: str) -> str:
    return (
        f"Job posting URL: {source_url}\n\n"
        f"Page text:\n\"\"\"\n{page_text}\n\"\"\"\n\n"
        "Extract the job details as JSON."
    )


def build_jd_from_url_user_turn(source_url: str, user_hint: str = "") -> str:
    """Fallback when the page could not be fetched -- infer from the URL alone."""
    hint = f"\nThe candidate also said: \"{user_hint}\"" if user_hint.strip() else ""
    return (
        f"The job posting page at {source_url} could not be downloaded.{hint}\n\n"
        "Infer whatever you legitimately can from the URL itself (company and "
        "role are often in the path). Use 'Not mentioned' for everything the "
        "URL does not reveal -- do NOT guess skills, experience or "
        "responsibilities. Return the same JSON shape."
    )


# ---------------------------------------------------------------------------
# 2. Candidate name extraction
# ---------------------------------------------------------------------------

SYSTEM_PROMPT_NAME = """\
You pull a person's name out of a short reply they gave when asked their name.

Return ONE JSON object and nothing else:
{"name": "the name exactly as they gave it, or null if no name is present"}

Rules:
- "My name is Aditi Sharma" -> {"name": "Aditi Sharma"}
- "Rohan" -> {"name": "Rohan"}
- "I'd rather not say" / "let's start" / "" -> {"name": null}
- Return only the person's own name. Never invent one, and never return a
  company, a technology, or a greeting as the name.
"""


def build_name_user_turn(reply: str) -> str:
    return f"The candidate was asked their name and replied: \"{reply}\"\n\nExtract the name."


# ---------------------------------------------------------------------------
# 3. Question generation
# ---------------------------------------------------------------------------

SYSTEM_PROMPT_QUESTION = """\
You are conducting a live technical mock interview for a student. You ask
ONE question per turn, out loud, the way a real interviewer would.

How to choose the next question:
- Read the candidate's most recent answer first. If it opens something worth
  probing -- a claim to verify, a shallow spot, an interesting detail -- ask a
  natural FOLLOW-UP on it and set "is_follow_up": true.
- If the last answer is finished, wrong in a way that further probing will not
  help, or the topic is exhausted, move to a NEW topic drawn from the
  interview context, and set "is_follow_up": false.
- Cover a spread of topics across the interview rather than drilling one area
  to death. Mix concept questions with applied / scenario questions.
- Scale difficulty to the experience level in the interview context. For a
  fresher or entry-level role, stay on fundamentals and projects.

Style rules:
- One question per turn. Never number them, never ask two things at once.
- Speak naturally and warmly, like a person, not a form. A brief
  acknowledgement of the previous answer before the question is good.
- Keep it under about 60 words.
- Never reveal the answer, never grade the candidate out loud, never mention
  that you are an AI, a model, or a prompt.
- Honour any extra condition the candidate set for this interview.

Return ONE JSON object and nothing else:
{
  "question": "the full text to say to the candidate, acknowledgement included",
  "topic": "short topic label, e.g. 'React', 'System Design', 'Behavioural'",
  "is_follow_up": true or false,
  "should_end": true or false,
  "end_reason": "short reason, or empty string"
}

Set "should_end": true ONLY when the interview has genuinely run its course --
the context is fully covered and further questions would repeat. Do not set it
because the candidate answered badly. Whether the candidate asked to stop, and
whether time has run out, are decided outside of you -- ignore both.
"""


def _context_block(
    source: str,
    job: Optional[Dict[str, Any]],
    profile: Optional[Dict[str, Any]],
    extra_conditions: str,
) -> str:
    lines: List[str] = [f"Interview type: {source}"]
    if job:
        lines.append("Target job:\n" + json.dumps(job, indent=2, ensure_ascii=False))
    if profile:
        lines.append("Candidate profile:\n" + json.dumps(profile, indent=2, ensure_ascii=False))
    if extra_conditions.strip():
        lines.append(f"Extra condition the candidate asked for: {extra_conditions.strip()}")
    return "\n\n".join(lines)


def build_question_user_turn(
    *,
    candidate_name: str,
    source: str,
    job: Optional[Dict[str, Any]],
    profile: Optional[Dict[str, Any]],
    extra_conditions: str,
    transcript: str,
    questions_asked: int,
    min_questions: int,
    max_questions: int,
    seconds_remaining: int,
    is_first: bool,
) -> str:
    context = _context_block(source, job, profile, extra_conditions)
    if is_first:
        instruction = (
            f"This is the very first question. {candidate_name} has just introduced "
            "themselves. Greet them by name in one short line, then ask your opening "
            "question -- something that gets them talking about their own background "
            "or the role."
        )
    else:
        instruction = (
            "Read the last answer in the transcript and ask the next question."
        )

    return (
        f"{context}\n\n"
        f"Candidate name: {candidate_name}\n"
        f"Questions asked so far: {questions_asked}\n"
        f"Interview length target: {min_questions}-{max_questions} total questions. "
        f"Set should_end=true once at least {min_questions} answers provide enough coverage; "
        f"the controller will always stop at {max_questions}.\n"
        f"Time remaining in this interview: about {seconds_remaining // 60} minute(s)\n\n"
        f"Transcript so far:\n{transcript or '(nothing yet)'}\n\n"
        f"{instruction}"
    )


# ---------------------------------------------------------------------------
# 4. Report generation
# ---------------------------------------------------------------------------

SYSTEM_PROMPT_REPORT = """\
You assess a finished mock interview and produce a scored report.

Score two major factors, each out of 10:

1. TECHNICAL
   - technical_skills : correctness and depth of domain knowledge shown
   - problem_solving  : how the candidate reasons through a problem, handles
                        an unfamiliar case, breaks things down

2. COMMUNICATION
   - clarity          : is the point understandable on first hearing
   - answer_structure : does the answer have a shape (context, action, result)
                        or does it wander
   - fillers          : verbal filler and hedging density ("um", "like",
                        "basically", "you know"). A HIGH score means FEW
                        fillers.
   - conciseness      : says enough, stops there. A high score means neither
                        rambling nor one-word answers.

Also produce:
- topics    : one entry per distinct topic the interview covered, each scored,
              with what the candidate did well and badly on that topic.
- skill_gaps: concrete skills or areas the interview showed the candidate is
              missing or weak in, phrased as things to go learn. This is the
              single most useful part of the report -- be specific and
              actionable, not generic.

Return ONE JSON object and nothing else:
{
  "overall_score": 0-10,
  "technical": {
    "score": 0-10,
    "technical_skills": {"score": 0-10, "strength": ["..."], "weakness": ["..."]},
    "problem_solving":  {"score": 0-10, "strength": ["..."], "weakness": ["..."]}
  },
  "communication": {
    "score": 0-10,
    "clarity":          {"score": 0-10, "strength": ["..."], "weakness": ["..."]},
    "answer_structure": {"score": 0-10, "strength": ["..."], "weakness": ["..."]},
    "fillers":          {"score": 0-10, "strength": ["..."], "weakness": ["..."]},
    "conciseness":      {"score": 0-10, "strength": ["..."], "weakness": ["..."]}
  },
  "topics": [
    {"topic": "React", "score": 0-10, "strength": ["..."], "weakness": ["..."]}
  ],
  "skill_gaps": ["..."],
  "summary": "3-5 sentences addressed to the candidate, honest and encouraging"
}

Rules:
- Judge ONLY what is in the transcript. Never credit or penalise something
  the candidate was never asked about.
- Every strength and weakness must be traceable to an actual answer. Quote or
  paraphrase the evidence. No generic filler like "good communication skills".
- A short interview is not automatically a bad one. If there is genuinely too
  little evidence to score a sub-factor, give it a neutral 5 and say so in its
  weakness list.
- Keep each strength / weakness entry to one sentence, at most 4 entries per list.
"""


def build_report_user_turn(
    *,
    candidate_name: str,
    source: str,
    role: str,
    job: Optional[Dict[str, Any]],
    profile: Optional[Dict[str, Any]],
    transcript: str,
    duration_minutes: float,
    questions_asked: int,
    end_reason: str,
) -> str:
    context = _context_block(source, job, profile, "")
    return (
        f"{context}\n\n"
        f"Candidate: {candidate_name}\n"
        f"Interviewing for: {role}\n"
        f"Interview length: {duration_minutes} minute(s), {questions_asked} question(s)\n"
        f"How it ended: {end_reason}\n\n"
        f"Full transcript:\n{transcript or '(the candidate answered nothing)'}\n\n"
        "Produce the assessment JSON."
    )
