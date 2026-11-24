from __future__ import annotations

from datetime import timedelta
from typing import List

from app.agents.job_eligibility.models import (
    AnomalyFlag,
    AnomalyType,
    EligibilityCriteria,
    OverrideRecord,
    Severity,
)


def detect_rule_conflicts(criteria: EligibilityCriteria) -> List[AnomalyFlag]:
    """Sanity-check a job's own rule-set for internally inconsistent or
    out-of-range values, independent of any student or override -- a
    posting can be broken before anyone ever applies to it."""

    flags: List[AnomalyFlag] = []

    def flag(desc: str, severity: Severity = Severity.MEDIUM) -> None:
        flags.append(AnomalyFlag(
            type=AnomalyType.RULE_CONFLICT, severity=severity,
            job_id=criteria.job_id, description=desc,
        ))

    if criteria.min_cgpa is not None and not (0.0 <= criteria.min_cgpa <= 10.0):
        flag(f"min_cgpa={criteria.min_cgpa} is outside the valid 0-10 scale.", Severity.HIGH)

    if criteria.max_backlogs is not None and criteria.max_backlogs < 0:
        flag(f"max_backlogs={criteria.max_backlogs} is negative.", Severity.HIGH)

    for label, val in (
        ("min_tenth_percentage", criteria.min_tenth_percentage),
        ("min_twelfth_percentage", criteria.min_twelfth_percentage),
    ):
        if val is not None and not (0.0 <= val <= 100.0):
            flag(f"{label}={val} is outside the valid 0-100 range.", Severity.HIGH)

    if (criteria.min_experience_months is not None and criteria.max_experience_months is not None
            and criteria.min_experience_months > criteria.max_experience_months):
        flag(f"min_experience_months ({criteria.min_experience_months}) exceeds "
             f"max_experience_months ({criteria.max_experience_months}) -- no candidate can qualify.",
             Severity.HIGH)

    overlap = set(criteria.allowed_branches) & set(criteria.excluded_branches)
    if overlap:
        flag(f"Branches {sorted(overlap)} appear in both allowed_branches and excluded_branches.", Severity.HIGH)
    elif criteria.allowed_branches and set(criteria.allowed_branches) <= set(criteria.excluded_branches):
        flag("Every allowed branch is also excluded -- this posting is unfillable.", Severity.HIGH)

    return flags


def _check_override(override: OverrideRecord, log_including_self: List[OverrideRecord],
                     window: timedelta = timedelta(minutes=10), burst_threshold: int = 3) -> List[AnomalyFlag]:
    """Anomaly checks for one override, given the override log up to and
    including it (needed for burst detection). Pure function -- used by
    both the live `register_override` path and the batch `audit_overrides`
    path so the two can't drift apart."""

    flags: List[AnomalyFlag] = []

    if override.override_verdict == override.rule_engine_verdict:
        flags.append(AnomalyFlag(
            type=AnomalyType.REDUNDANT_OVERRIDE, severity=Severity.LOW,
            job_id=override.job_id, student_id=override.student_id,
            tpo_staff_id=override.tpo_staff_id, override_id=override.override_id,
            description=(f"Override by {override.tpo_staff_id} sets the same verdict "
                         f"({override.override_verdict}) the rule engine already produced -- "
                         "no effective change, possibly an accidental submission."),
        ))

    if not override.reason or len(override.reason.strip()) < 15:
        flags.append(AnomalyFlag(
            type=AnomalyType.OVERRIDE_WITHOUT_REASON, severity=Severity.MEDIUM,
            job_id=override.job_id, student_id=override.student_id,
            tpo_staff_id=override.tpo_staff_id, override_id=override.override_id,
            description=(f"Override by {override.tpo_staff_id} on student {override.student_id} "
                         "has no (or a too-brief) audit reason logged."),
        ))

    if override.override_verdict != override.rule_engine_verdict:
        flags.append(AnomalyFlag(
            type=AnomalyType.OVERRIDE_CONTRADICTS_RULES, severity=Severity.MEDIUM,
            job_id=override.job_id, student_id=override.student_id,
            tpo_staff_id=override.tpo_staff_id, override_id=override.override_id,
            description=(f"{override.tpo_staff_id} flipped the rule engine's verdict "
                         f"({override.rule_engine_verdict} -> {override.override_verdict}) for student "
                         f"{override.student_id} on job {override.job_id}."),
        ))

    recent = [
        o for o in log_including_self
        if o.tpo_staff_id == override.tpo_staff_id and override.timestamp - o.timestamp <= window
    ]
    if len(recent) >= burst_threshold:
        flags.append(AnomalyFlag(
            type=AnomalyType.OVERRIDE_BURST,
            severity=Severity.HIGH if len(recent) >= burst_threshold * 2 else Severity.MEDIUM,
            job_id=override.job_id, tpo_staff_id=override.tpo_staff_id, override_id=override.override_id,
            description=(f"{override.tpo_staff_id} has made {len(recent)} override(s) in the last "
                         f"{int(window.total_seconds() // 60)} minute(s) -- flagged for audit review."),
        ))

    return flags


def register_override(overrides_log: List[OverrideRecord], override: OverrideRecord) -> List[AnomalyFlag]:
    """Append a new override to the live audit log and return whatever
    anomalies it raises. Call this every time a TPO manually flips a
    verdict -- it's the single write path for the override audit trail."""
    overrides_log.append(override)
    return _check_override(override, overrides_log)


def audit_overrides(overrides_log: List[OverrideRecord]) -> List[AnomalyFlag]:
    """Batch anomaly sweep over an existing override log (e.g. pulled from
    the database for a periodic report), independent of the live
    `register_override` call path."""
    ordered = sorted(overrides_log, key=lambda o: o.timestamp)
    flags: List[AnomalyFlag] = []
    for i, o in enumerate(ordered):
        flags.extend(_check_override(o, ordered[: i + 1]))
    return flags


def detect_anomalies(criteria_list: List[EligibilityCriteria],
                      overrides_log: List[OverrideRecord]) -> List[AnomalyFlag]:
    """Full audit sweep: rule conflicts across every posting's criteria,
    plus the entire override history. This is what the TPO-facing audit
    report calls."""
    flags: List[AnomalyFlag] = []
    for c in criteria_list:
        flags.extend(detect_rule_conflicts(c))
    flags.extend(audit_overrides(overrides_log))
    return flags