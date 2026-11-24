import re
from typing import Tuple, List

CATEGORIES = [
    "Technology",
    "Finance",
    "Business & Management",
    "Marketing & Sales",
    "Human Resources",
    "Design & Creative",
    "Healthcare",
    "Legal",
    "Research",
    "Engineering",
    "Manufacturing",
    "Education",
    "Consulting",
    "Supply Chain & Logistics",
    "Customer Support",
    "Other",
]


def classify_job(
    title: str,
    description: str = "",
    requirements: str = "",
    skills: List[str] = None
) -> Tuple[str, str]:
    """
    Classify a job into (Category, Subcategory) based on title, description, requirements, skills.
    Returns primary category and subcategory string.
    """
    title_lower = (title or "").lower()
    desc_lower = (description or "").lower()
    req_lower = (requirements or "").lower()
    skills_str = " ".join(skills or []).lower()

    combined_text = f"{title_lower} {title_lower} {desc_lower[:500]} {req_lower[:300]} {skills_str}"

    # 1. Technology Rules
    if any(kw in title_lower for kw in ["machine learning", "ml ", "ai ", "artificial intelligence", "deep learning", "llm", "nlp", "prompt"]):
        return "Technology", "AI / Machine Learning"
    if any(kw in title_lower for kw in ["data scientist", "data science", "data analyst", "analytics", "bi engineer"]):
        return "Technology", "Data Science"
    if any(kw in title_lower for kw in ["devops", "cloud", "sre", "infrastructure", "kubernetes", "aws", "sysadmin"]):
        return "Technology", "DevOps & Cloud"
    if any(kw in title_lower for kw in ["security", "cybersecurity", "infosec", "penetration", "soc analyst"]):
        return "Technology", "Cybersecurity"
    if any(kw in title_lower for kw in ["ios", "android", "mobile", "flutter", "react native"]):
        return "Technology", "Mobile Development"
    if any(kw in title_lower for kw in ["frontend", "backend", "fullstack", "full stack", "software engineer", "developer", "programmer", "web developer", "coder", "qa ", "test engineer", "automation engineer"]):
        return "Technology", "Software Development"
    if "tech" in title_lower or "software" in title_lower or "developer" in title_lower:
        return "Technology", "Software Development"

    # 2. Finance Rules
    if any(kw in title_lower for kw in ["investment banking", "investment analyst", "equity research"]):
        return "Finance", "Investment Banking"
    if any(kw in title_lower for kw in ["accounting", "accountant", "audit", "tax", "payroll", "bookkeeper"]):
        return "Finance", "Accounting & Taxation"
    if any(kw in title_lower for kw in ["finance", "financial analyst", "controller", "treasury", "fintech", "wealth"]):
        return "Finance", "Financial Analysis"

    # 3. Business & Management Rules
    if any(kw in title_lower for kw in ["product manager", "product owner", "associate product manager", "gpm", "cpo"]):
        return "Business & Management", "Product Management"
    if any(kw in title_lower for kw in ["project manager", "program manager", "scrum master", "agile coach"]):
        return "Business & Management", "Project & Program Management"
    if any(kw in title_lower for kw in ["strategy", "operations", "business analyst", "general manager", "chief of staff", "ceo", "coo"]):
        return "Business & Management", "Operations & Strategy"

    # 4. Marketing & Sales Rules
    if any(kw in title_lower for kw in ["sales", "account executive", "business development", "sdr", "bdr", "account manager"]):
        return "Marketing & Sales", "Sales & Business Development"
    if any(kw in title_lower for kw in ["marketing", "seo", "sem", "content writer", "social media", "brand", "growth"]):
        return "Marketing & Sales", "Marketing"

    # 5. Human Resources Rules
    if any(kw in title_lower for kw in ["hr ", "human resources", "recruiter", "talent acquisition", "people ops", "headhunter"]):
        return "Human Resources", "Recruitment / HR"

    # 6. Design & Creative Rules
    if any(kw in title_lower for kw in ["ui/ux", "ui designer", "ux designer", "graphic designer", "visual designer", "animator", "copywriter", "creative director"]):
        return "Design & Creative", "UI/UX & Design"

    # 7. Healthcare Rules
    if any(kw in title_lower for kw in ["nurse", "physician", "doctor", "medical", "clinical", "pharma", "biotech", "healthcare"]):
        return "Healthcare", "Clinical & Medical"

    # 8. Legal Rules
    if any(kw in title_lower for kw in ["legal", "counsel", "lawyer", "paralegal", "compliance", "attorney"]):
        return "Legal", "Legal & Compliance"

    # 9. Research Rules
    if any(kw in title_lower for kw in ["researcher", "scientist", "lab assistant", "postdoc", "r&d"]):
        return "Research", "Research & Development"

    # 10. Engineering Rules (Non-Software)
    if any(kw in title_lower for kw in ["mechanical engineer", "electrical engineer", "civil engineer", "chemical engineer", "hardware engineer"]):
        return "Engineering", "Core Engineering"

    # 11. Manufacturing Rules
    if any(kw in title_lower for kw in ["factory", "plant manager", "machinist", "assembly", "quality control"]):
        return "Manufacturing", "Manufacturing & Operations"

    # 12. Education Rules
    if any(kw in title_lower for kw in ["teacher", "professor", "tutor", "academic", "curriculum", "instructor"]):
        return "Education", "Teaching & Academia"

    # 13. Consulting Rules
    if any(kw in title_lower for kw in ["consultant", "advisory", "management consultant"]):
        return "Consulting", "Management Consulting"

    # 14. Supply Chain & Logistics Rules
    if any(kw in title_lower for kw in ["supply chain", "logistics", "warehouse", "procurement", "inventory"]):
        return "Supply Chain & Logistics", "Logistics & Supply Chain"

    # 15. Customer Support Rules
    if any(kw in title_lower for kw in ["customer support", "customer service", "helpdesk", "client success", "support engineer"]):
        return "Customer Support", "Customer Support & Success"

    # Fallback checking combined text keywords
    if "python" in combined_text or "code" in combined_text or "developer" in combined_text:
        return "Technology", "Software Development"
    if "finance" in combined_text or "money" in combined_text:
        return "Finance", "Financial Analysis"

    return "Other", "General"
