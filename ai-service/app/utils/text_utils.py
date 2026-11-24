import re
from typing import List, Tuple

NOT_MENTIONED = "Not mentioned"

COMMON_SKILLS = [
    "Python", "Java", "JavaScript", "TypeScript", "C++", "C#", "Go", "Rust", "Ruby", "PHP",
    "Swift", "Kotlin", "SQL", "NoSQL", "PostgreSQL", "MongoDB", "MySQL", "Redis", "Elasticsearch",
    "React", "Angular", "Vue", "Next.js", "Node.js", "Express", "Django", "FastAPI", "Flask", "Spring Boot",
    "AWS", "Azure", "GCP", "Docker", "Kubernetes", "Terraform", "CI/CD", "Git", "Linux",
    "PyTorch", "TensorFlow", "Scikit-Learn", "Machine Learning", "Deep Learning", "NLP", "LLMs", "Generative AI",
    "Pandas", "NumPy", "Apache Spark", "Hadoop", "Airflow", "Tableau", "Power BI",
    "REST API", "GraphQL", "Microservices", "System Design", "Agile", "Scrum", "Jira",
    "Figma", "UI/UX", "Excel", "Financial Modeling", "SEO", "Google Analytics"
]


def clean_text(text: str) -> str:
    """Clean HTML tags and normalize whitespace in text string."""
    if not text or not isinstance(text, str):
        return ""
    # Strip HTML tags
    cleaned = re.sub(r'<[^>]+>', ' ', text)
    # Replace non-breaking spaces and redundant whitespaces
    cleaned = cleaned.replace('\xa0', ' ').replace('\u200b', ' ')
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    return cleaned


def extract_skills(text: str) -> List[str]:
    """Extract known technical and professional skills from text."""
    if not text:
        return []
    found_skills = []
    
    for skill in COMMON_SKILLS:
        # Match as whole word pattern
        pattern = r'\b' + re.escape(skill) + r'\b'
        if re.search(pattern, text, re.IGNORECASE):
            found_skills.append(skill)
            
    return list(dict.fromkeys(found_skills))  # Preserve order & deduplicate


def parse_salary_or_stipend(text: str) -> Tuple[str, str]:
    """Parse salary ranges or intern stipend figures from text string."""
    if not text:
        return NOT_MENTIONED, NOT_MENTIONED

    salary = NOT_MENTIONED
    stipend = NOT_MENTIONED

    # Salary patterns ($50k-$100k, $120,000 / year, INR 10-15 LPA, ₹5,00,000)
    salary_match = re.search(
        r'(\$|₹|USD|EUR|GBP|INR)\s?[\d,]+(?:\.\d+)?\s*(?:-|to)?\s*(?:(\$|₹|USD|EUR|GBP|INR)\s?)?[\d,]+(?:\.\d+)?\s*(?:k|k/yr|/year|/yr|per year|LPA|lpa)?',
        text, re.IGNORECASE
    )
    if salary_match:
        salary = salary_match.group(0).strip()

    # Stipend patterns ($25/hr, ₹20,000/month, $1000/mo)
    stipend_match = re.search(
        r'(\$|₹|USD|INR)\s?[\d,]+\s*(?:/hr|/hour|/month|/mo|per month|pm|stipend)',
        text, re.IGNORECASE
    )
    if stipend_match:
        stipend = stipend_match.group(0).strip()

    return salary, stipend
