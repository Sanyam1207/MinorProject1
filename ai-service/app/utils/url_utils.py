import ipaddress
import socket
from urllib.parse import urlparse, urljoin, urlunparse


def validate_url(url: str) -> bool:
    """Check if a URL is structurally valid and uses http/https scheme."""
    if not url or not isinstance(url, str):
        return False
    url = url.strip()
    try:
        parsed = urlparse(url)
        if parsed.scheme.lower() not in ("http", "https"):
            return False
        if not parsed.netloc:
            return False
        return True
    except Exception:
        return False


def is_safe_url(url: str) -> bool:
    """
    SSRF Protection: Check if URL host resolves to internal, private,
    loopback, link-local (e.g. AWS 169.254.169.254), or reserved IP addresses.
    """
    if not validate_url(url):
        return False

    try:
        parsed = urlparse(url)
        hostname = parsed.hostname
        if not hostname:
            return False

        # Check explicitly forbidden hostnames
        forbidden_hosts = {"localhost", "127.0.0.1", "0.0.0.0", "::1", "metadata.google.internal"}
        if hostname.lower() in forbidden_hosts:
            return False

        # Resolve IP addresses for host
        addr_info = socket.getaddrinfo(hostname, None)
        if not addr_info:
            return False

        for family, _, _, _, sockaddr in addr_info:
            ip_str = sockaddr[0]
            ip = ipaddress.ip_address(ip_str)

            if (
                ip.is_private
                or ip.is_loopback
                or ip.is_link_local
                or ip.is_multicast
                or ip.is_reserved
                or ip.is_unspecified
            ):
                return False

        return True
    except Exception:
        return False


def get_domain(url: str) -> str:
    """Extract domain from URL."""
    try:
        parsed = urlparse(url)
        return parsed.netloc.lower()
    except Exception:
        return ""


def normalize_url(url: str, base_url: str = "") -> str:
    """Resolve relative URLs against base_url and strip tracking query parameters."""
    if not url:
        return ""
    try:
        if base_url:
            url = urljoin(base_url, url)
        parsed = urlparse(url)

        # Strip standard UTM tracking params
        query_parts = []
        if parsed.query:
            for q in parsed.query.split("&"):
                if not q.lower().startswith(("utm_", "ref=", "source=", "fbclid=", "gclid=")):
                    query_parts.append(q)
        clean_query = "&".join(query_parts)

        # Reconstruct clean URL
        normalized = urlunparse((
            parsed.scheme.lower(),
            parsed.netloc.lower(),
            parsed.path.rstrip('/') if parsed.path != '/' else '/',
            parsed.params,
            clean_query,
            ""  # drop fragment
        ))
        return normalized
    except Exception:
        return url
