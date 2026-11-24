from app.agents import REGISTRY


def test_registry_loads_all_agents():
    assert "resume-generator" in REGISTRY
    assert "ai-interviewer" in REGISTRY
