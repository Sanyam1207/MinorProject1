from enum import Enum
from typing import Any, Optional


class AgentMode(str, Enum):
    JOBS = "jobs-finder"
    RESUME = "resume-generator"
    ELIGIBILITY = "job-eligibility"
    JOB_CREATION = "job-creation"
    INTERVIEW = "ai-interviewer"
    PR_OUTREACH = "pr-outreach"
    ALUMNI_CONNECT = "alumni-connect"
    GAP_ANALYSIS = "gap-analysis"
    LEARNING_RECOMMENDATION = "learning-recommendation"
    # Tool-calling campus assistant (attendance, applications, offers, ...).
    # Also the fallback when no other agent matches.
    COPILOT = "copilot"

    @classmethod
    def from_name(cls, mode_name: Any) -> Optional["AgentMode"]:
        if isinstance(mode_name, dict):
            mode_name = (
                mode_name.get("mode")
                or mode_name.get("intent")
                or mode_name.get("target_mode")
                or mode_name.get("action")
            )
        if not isinstance(mode_name, str) or not mode_name:
            return None

        normalized = mode_name.strip().lower().replace("_", "-").replace(" ", "-")
        aliases = {
            "jobs": cls.JOBS,
            "job": cls.JOBS,
            "job-finder": cls.JOBS,
            "resume": cls.RESUME,
            "cv": cls.RESUME,
            "eligibility": cls.ELIGIBILITY,
            "job-eligibility": cls.ELIGIBILITY,
            "job-eligiblity": cls.ELIGIBILITY,
            # Job Creation aliases
            "job-creator": cls.JOB_CREATION,
            "job-creater": cls.JOB_CREATION,
            "create-job": cls.JOB_CREATION,
            "post-job": cls.JOB_CREATION,
            "job-posting": cls.JOB_CREATION,
            "job-post": cls.JOB_CREATION,
            # AI Interviewer aliases
            "interview": cls.INTERVIEW,
            "interviewer": cls.INTERVIEW,
            "ai-interview": cls.INTERVIEW,
            "mock-interview": cls.INTERVIEW,
            "mock-interviewer": cls.INTERVIEW,
            "interview-prep": cls.INTERVIEW,
            "practice-interview": cls.INTERVIEW,
            # PR Outreach aliases
            "pr-outreach": cls.PR_OUTREACH,
            "outreach": cls.PR_OUTREACH,
            "pr": cls.PR_OUTREACH,
            # Alumni mentorship aliases
            "alumni": cls.ALUMNI_CONNECT,
            "mentor": cls.ALUMNI_CONNECT,
            "mentorship": cls.ALUMNI_CONNECT,
            "alumni-connect": cls.ALUMNI_CONNECT,
            "alumni-connection": cls.ALUMNI_CONNECT,
            # Gap Analysis aliases
            "gap-analysis": cls.GAP_ANALYSIS,
            "gap": cls.GAP_ANALYSIS,
            "curriculum-gap": cls.GAP_ANALYSIS,
            "elective-suggestion": cls.GAP_ANALYSIS,
            "skill-gap-analysis": cls.GAP_ANALYSIS,
            # Post-interview readable learning recommendations
            "recommendation": cls.LEARNING_RECOMMENDATION,
            "recommendations": cls.LEARNING_RECOMMENDATION,
            "learning-recommendation": cls.LEARNING_RECOMMENDATION,
            "learning-plan": cls.LEARNING_RECOMMENDATION,
            "improvement-plan": cls.LEARNING_RECOMMENDATION,
            # Copilot aliases -- attendance is served by the copilot's tools,
            # never by a separate attendance mode.
            "copilot": cls.COPILOT,
            "assistant": cls.COPILOT,
            "agent": cls.COPILOT,
            "general": cls.COPILOT,
            "campus-assistant": cls.COPILOT,
            "attendance": cls.COPILOT,
            "attendance-agent": cls.COPILOT,
        }
        return aliases.get(normalized) or next(
            (mode for mode in cls if mode.value == normalized), None
        )
