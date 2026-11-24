from app.agents.base import Agent
from app.agents.resume_generator.agent import ResumeGeneratorAgent
from app.agents.jobscrapper import JobFinderAgent
from app.agents.job_eligibility import JobEligibilityAgent
from app.agents.job_creator.agent import JobCreationAgent
from app.agents.interviewer.agent import InterviewerAgent
from app.agents.pr_outreach.agent import PROutreachAgent
from app.agents.alumni_connect.agent import AlumniConnectAgent
from app.agents.gap_analysis.agent import GapAnalysisAgent
from app.agents.learning_recommendation.agent import LearningRecommendationAgent

# Every agent the orchestrator can route to, keyed by name.
REGISTRY: dict[str, Agent] = {
    a.name: a
    for a in (
        ResumeGeneratorAgent(),
        JobFinderAgent(),
        JobEligibilityAgent(),
        JobCreationAgent(),
        InterviewerAgent(),
        PROutreachAgent(),
        AlumniConnectAgent(),
        GapAnalysisAgent(),
        LearningRecommendationAgent(),
    )
}

__all__ = [
    "Agent", "REGISTRY",
    "ResumeGeneratorAgent", "JobFinderAgent",
    "JobEligibilityAgent", "JobCreationAgent",
    "InterviewerAgent",
    "PROutreachAgent",
    "AlumniConnectAgent",
    "GapAnalysisAgent",
    "LearningRecommendationAgent",
]
