from __future__ import annotations

from typing import List

from app.agents.job_eligibility.models import (
    CriterionResult,
    EligibilityCriteria,
    EligibilityVerdict,
    StudentProfile,
)


def evaluate_student(student: StudentProfile, criteria: EligibilityCriteria) -> List[CriterionResult]:
    """Check `student` against every criterion `criteria` actually sets.

    Only criteria present on the posting produce a CriterionResult -- an
    unset field is skipped rather than auto-passed or auto-failed, so the
    result list doubles as a record of exactly which rules applied.
    """
    results: List[CriterionResult] = []

    if criteria.min_cgpa is not None:
        passed = student.cgpa >= criteria.min_cgpa
        results.append(CriterionResult(
            criterion="Minimum CGPA",
            required=f">= {criteria.min_cgpa:.2f}",
            actual=f"{student.cgpa:.2f}",
            passed=passed,
            detail=(f"Your CGPA of {student.cgpa:.2f} meets the {criteria.min_cgpa:.2f} minimum."
                    if passed else
                    f"Your CGPA of {student.cgpa:.2f} is below the required minimum of {criteria.min_cgpa:.2f}."),
        ))

    if criteria.max_backlogs is not None:
        passed = student.active_backlogs <= criteria.max_backlogs
        results.append(CriterionResult(
            criterion="Active backlogs",
            required=f"<= {criteria.max_backlogs}",
            actual=str(student.active_backlogs),
            passed=passed,
            detail=(f"You have {student.active_backlogs} active backlog(s), within the allowed {criteria.max_backlogs}."
                    if passed else
                    f"You have {student.active_backlogs} active backlog(s), which exceeds the allowed maximum of {criteria.max_backlogs}."),
        ))

    if criteria.allowed_branches:
        normalized_branch = student.branch.strip().casefold()
        normalized_allowed = {branch.strip().casefold() for branch in criteria.allowed_branches}
        passed = normalized_branch in normalized_allowed
        results.append(CriterionResult(
            criterion="Branch",
            required=", ".join(criteria.allowed_branches),
            actual=student.branch,
            passed=passed,
            detail=(f"Your branch ({student.branch}) is on the eligible list."
                    if passed else
                    f"Your branch ({student.branch}) is not among the eligible branches: {', '.join(criteria.allowed_branches)}."),
        ))

    normalized_excluded = {branch.strip().casefold() for branch in criteria.excluded_branches}
    if criteria.excluded_branches and student.branch.strip().casefold() in normalized_excluded:
        results.append(CriterionResult(
            criterion="Branch exclusion",
            required=f"not in {', '.join(criteria.excluded_branches)}",
            actual=student.branch,
            passed=False,
            detail=f"Your branch ({student.branch}) is explicitly excluded from this posting.",
        ))

    if criteria.min_tenth_percentage is not None:
        actual = student.tenth_percentage
        passed = actual is not None and actual >= criteria.min_tenth_percentage
        results.append(CriterionResult(
            criterion="10th percentage",
            required=f">= {criteria.min_tenth_percentage:.1f}%",
            actual=f"{actual:.1f}%" if actual is not None else "Not mentioned",
            passed=passed,
            detail=(f"Your 10th percentage of {actual:.1f}% clears the {criteria.min_tenth_percentage:.1f}% cut-off."
                    if passed else
                    f"Your 10th percentage ({actual if actual is not None else 'not on record'}) does not clear "
                    f"the {criteria.min_tenth_percentage:.1f}% cut-off."),
        ))

    if criteria.min_twelfth_percentage is not None:
        actual = student.twelfth_percentage
        passed = actual is not None and actual >= criteria.min_twelfth_percentage
        results.append(CriterionResult(
            criterion="12th percentage",
            required=f">= {criteria.min_twelfth_percentage:.1f}%",
            actual=f"{actual:.1f}%" if actual is not None else "Not mentioned",
            passed=passed,
            detail=(f"Your 12th percentage of {actual:.1f}% clears the {criteria.min_twelfth_percentage:.1f}% cut-off."
                    if passed else
                    f"Your 12th percentage ({actual if actual is not None else 'not on record'}) does not clear "
                    f"the {criteria.min_twelfth_percentage:.1f}% cut-off."),
        ))

    if criteria.allowed_graduation_years:
        passed = student.graduation_year in criteria.allowed_graduation_years
        results.append(CriterionResult(
            criterion="Graduation year",
            required=", ".join(str(y) for y in criteria.allowed_graduation_years),
            actual=str(student.graduation_year) if student.graduation_year else "Not mentioned",
            passed=passed,
            detail=(f"Your graduation year ({student.graduation_year}) matches this drive."
                    if passed else
                    f"This drive is open to {', '.join(str(y) for y in criteria.allowed_graduation_years)} graduates; "
                    f"you are {student.graduation_year}."),
        ))

    if criteria.allowed_categories:
        passed = student.category in criteria.allowed_categories
        results.append(CriterionResult(
            criterion="Category",
            required=", ".join(criteria.allowed_categories),
            actual=student.category,
            passed=passed,
            detail=(f"Your category ({student.category}) is eligible for this posting."
                    if passed else
                    f"This posting is restricted to {', '.join(criteria.allowed_categories)} category candidates."),
        ))

    if criteria.min_experience_months is not None:
        passed = student.experience_months >= criteria.min_experience_months
        results.append(CriterionResult(
            criterion="Minimum experience",
            required=f">= {criteria.min_experience_months} month(s)",
            actual=f"{student.experience_months} month(s)",
            passed=passed,
            detail=(f"Your {student.experience_months} month(s) of experience meets the requirement."
                    if passed else
                    f"You have {student.experience_months} month(s) of experience; "
                    f"{criteria.min_experience_months} required."),
        ))

    if criteria.max_experience_months is not None:
        passed = student.experience_months <= criteria.max_experience_months
        results.append(CriterionResult(
            criterion="Maximum experience",
            required=f"<= {criteria.max_experience_months} month(s)",
            actual=f"{student.experience_months} month(s)",
            passed=passed,
            detail=(f"Your {student.experience_months} month(s) of experience is within the freshers-only cap."
                    if passed else
                    f"This role is capped at {criteria.max_experience_months} month(s) experience; "
                    f"you have {student.experience_months}."),
        ))

    return results


def build_explanation(criteria: EligibilityCriteria, results: List[CriterionResult]) -> str:
    """Turn a list of CriterionResults into the "Why Am I Ineligible" text.

    Only the failed criteria get spelled out in detail -- that's the whole
    point of the feature: a student who fails 1 of 6 rules should see that
    one rule named, not a wall of boolean checks.
    """
    failed = [r for r in results if not r.passed]

    if not results:
        return f"No eligibility rules are configured for {criteria.job_title} yet -- nothing to check against."

    if not failed:
        return (f"You are eligible for {criteria.job_title}. "
                f"You clear all {len(results)} criteria set for this posting.")

    lines = [f"You are not eligible for {criteria.job_title}. "
             f"{len(failed)} of {len(results)} criteria were not met:"]
    for i, r in enumerate(failed, start=1):
        lines.append(f"{i}. {r.criterion} -- required {r.required}, you have {r.actual}. {r.detail}")

    passed_names = [r.criterion for r in results if r.passed]
    if passed_names:
        lines.append(f"Criteria you did clear: {', '.join(passed_names)}.")

    return "\n".join(lines)


def evaluate_eligibility(student: StudentProfile, criteria: EligibilityCriteria) -> EligibilityVerdict:
    """One-call entry point: run the rule engine and build the explanation
    from the same result set, so the two can't disagree."""
    results = evaluate_student(student, criteria)
    rule_eligible = all(r.passed for r in results)
    return EligibilityVerdict(
        student_id=student.student_id,
        job_id=criteria.job_id,
        rule_engine_eligible=rule_eligible,
        criteria_results=results,
        explanation=build_explanation(criteria, results),
    )
