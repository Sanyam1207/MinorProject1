from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Student / rules
# ---------------------------------------------------------------------------

class StudentProfile(BaseModel):
    """A student, as far as eligibility checking cares about them."""

    student_id: str
    name: str = "Not mentioned"
    branch: str = "Not mentioned"
    cgpa: float = Field(..., ge=0, le=10)
    active_backlogs: int = Field(default=0, ge=0)
    tenth_percentage: Optional[float] = None
    twelfth_percentage: Optional[float] = None
    graduation_year: Optional[int] = None
    category: str = "General"  # General / OBC / SC / ST / EWS / ...
    experience_months: int = Field(default=0, ge=0)


class EligibilityCriteria(BaseModel):
    """The rule-set a TPO attaches to a single job posting.

    Every field is optional -- an unset field means "not checked for this
    posting", not "everyone fails". Empty lists (`allowed_branches`,
    `allowed_graduation_years`, `allowed_categories`) mean "no restriction",
    matching how the rest of the codebase uses "Not mentioned" as an
    unset-but-valid value.
    """

    job_id: str
    job_title: str = "Not mentioned"
    min_cgpa: Optional[float] = Field(default=None, ge=0, le=10)
    max_backlogs: Optional[int] = Field(default=None, ge=0)
    allowed_branches: List[str] = Field(default_factory=list)
    excluded_branches: List[str] = Field(default_factory=list)
    min_tenth_percentage: Optional[float] = None
    min_twelfth_percentage: Optional[float] = None
    allowed_graduation_years: List[int] = Field(default_factory=list)
    allowed_categories: List[str] = Field(default_factory=list)
    min_experience_months: Optional[int] = None
    max_experience_months: Optional[int] = None


# ---------------------------------------------------------------------------
# Evaluation results
# ---------------------------------------------------------------------------

class CriterionResult(BaseModel):
    """The outcome of checking one criterion for one student."""

    criterion: str
    required: str
    actual: str
    passed: bool
    detail: str


class EligibilityVerdict(BaseModel):
    student_id: str
    job_id: str
    rule_engine_eligible: bool
    criteria_results: List[CriterionResult]
    explanation: str


# ---------------------------------------------------------------------------
# Overrides / anomalies
# ---------------------------------------------------------------------------

class OverrideRecord(BaseModel):
    """A TPO staff member manually setting a verdict that may or may not
    agree with what the rule engine produced."""

    override_id: str = Field(default_factory=lambda: uuid.uuid4().hex[:10])
    job_id: str
    student_id: str
    tpo_staff_id: str
    rule_engine_verdict: bool
    override_verdict: bool
    reason: str = ""
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class AnomalyType(str, Enum):
    RULE_CONFLICT = "RULE_CONFLICT"
    OVERRIDE_WITHOUT_REASON = "OVERRIDE_WITHOUT_REASON"
    OVERRIDE_CONTRADICTS_RULES = "OVERRIDE_CONTRADICTS_RULES"
    REDUNDANT_OVERRIDE = "REDUNDANT_OVERRIDE"
    OVERRIDE_BURST = "OVERRIDE_BURST"


class Severity(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class AnomalyFlag(BaseModel):
    anomaly_id: str = Field(default_factory=lambda: uuid.uuid4().hex[:10])
    type: AnomalyType
    severity: Severity
    job_id: str
    student_id: Optional[str] = None
    tpo_staff_id: Optional[str] = None
    override_id: Optional[str] = None
    description: str
