"""Bounded HTTP transport adapted from any-auto-register@44c27a8.

Unlike the reference, redirects and POST retries are never implicit. One profile,
proxy and cookie jar belong to one task, including Sentinel requests.
"""
import json
import re
import time
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import quote, urlsplit

from .errors import LoginError

AUTH = "https://auth.openai.com"
CHAT = "https://chatgpt.com"
SENTINEL = "https://sentinel.openai.com"
SDK_PATH = "/sentinel/20260219f9f6/sdk.js"
MAX_BODY = 4 * 1024 * 1024
# One supported curl profile; no family/IP rotation on challenge or credential failure.
FINGERPRINT = {
    "impersonate": "safari18_0", "browser_type": "mac_safari",
    "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    "navigator_platform": "MacIntel", "navigator_vendor": "Apple Computer, Inc.",
    "platform": "MacIntel", "vendor": "Apple Computer, Inc.",
    "lang": "en-US", "lang_full": "en-US,en;q=0.9", "screen": "1920x1080",
    "hardware_concurrency": 8, "device_memory": None, "max_touch_points": 0,
    "device_pixel_ratio": 2, "timezone": "America/New_York",
}
AUTH_POST_PATHS = {
    "/api/accounts/authorize/continue", "/api/accounts/password/verify",
    "/api/accounts/mfa/verify", "/api/accounts/workspace/select", "/api/accounts/session/select",
}
AUTH_GET_PATH = re.compile(
    r"^(?:/api/accounts/authorize|/(?:oauth/authorize|authorize|log-in(?:/password)?|login|mfa-challenge(?:/[A-Za-z0-9_-]+)?|"
    r"sign-in-with-chatgpt(?:/[A-Za-z0-9_-]+)*|workspace|consent|choose-an-account|"
    r"email-verification|add-phone|phone-verification)/?)$"
)


def parsed_url(url):
    if not isinstance(url, str) or not url or len(url) > 32768 or re.search(r"[\s\\\x00-\x1f\x7f]", url):
        raise LoginError("OAUTH_UNTRUSTED_ORIGIN")
    try:
        u = urlsplit(url)
        if u.username is not None or u.password is not None or u.fragment:
            raise ValueError()
        _ = u.port
        return u
    except ValueError:
        raise LoginError("OAUTH_UNTRUSTED_ORIGIN") from None


def check_url(method, url):
    u = parsed_url(url)
    if u.scheme != "https" or u.port not in (None, 443):
        raise LoginError("OAUTH_UNTRUSTED_ORIGIN")
    path = u.path or "/"
    allowed = False
    if u.hostname == "auth.openai.com":
        allowed = (method == "GET" and bool(AUTH_GET_PATH.fullmatch(path))) or (method == "POST" and path in AUTH_POST_PATHS)
    elif u.hostname == "chatgpt.com":
        allowed = (method == "GET" and path in {"/", "/api/auth/csrf", "/api/auth/session", "/api/auth/callback/openai"}) or (method == "POST" and path == "/api/auth/signin/openai")
    elif u.hostname == "sentinel.openai.com":
        allowed = (method == "GET" and path == SDK_PATH) or (method == "POST" and path == "/backend-api/sentinel/req")
    if not allowed:
        raise LoginError("OAUTH_UNTRUSTED_ORIGIN")
    return url


def proxy_url(proxy):
    if proxy is None:
        return None
    if not isinstance(proxy, dict):
        raise LoginError("OAUTH_INVALID_PROXY")
    protocol, host, port = (proxy.get(k) for k in ("protocol", "host", "port"))
    try:
        port = int(port)
    except (TypeError, ValueError):
        raise LoginError("OAUTH_INVALID_PROXY") from None
    if protocol not in {"http", "https", "socks5", "socks5h"} or not isinstance(host, str) or not 1 <= port <= 65535:
        raise LoginError("OAUTH_INVALID_PROXY")
    host = host.strip().strip("[]")
    if not host or re.search(r"[^A-Za-z0-9.:-]", host):
        raise LoginError("OAUTH_INVALID_PROXY")
    if ":" in host:
        import ipaddress
        try:
            ipaddress.IPv6Address(host)
        except ValueError:
            raise LoginError("OAUTH_INVALID_PROXY") from None
        host = f"[{host}]"
    username, password = proxy.get("username") or "", proxy.get("password") or ""
    if not isinstance(username, str) or not isinstance(password, str):
        raise LoginError("OAUTH_INVALID_PROXY")
    credentials = f"{quote(username, safe='')}:{quote(password, safe='')}@" if username or password else ""
    return f"{protocol}://{credentials}{host}:{port}"


@dataclass
class Response:
    status_code: int
    headers: dict
    text: str
    url: str

    def json(self):
        return json.loads(self.text)


# Diagnostics are labels, never a sanitized or truncated upstream URL.
CHALLENGE_PATHS = {
    "chatgpt.com": {
        "/": "warmup", "/api/auth/csrf": "csrf", "/api/auth/signin/openai": "web_signin",
        "/api/auth/session": "web_session", "/api/auth/callback/openai": "web_callback",
    },
    "auth.openai.com": {
        "/oauth/authorize": "authorize", "/authorize": "authorize", "/api/accounts/authorize": "authorize",
        "/consent": "authorize",
        "/api/accounts/authorize/continue": "email", "/log-in": "email", "/login": "email",
        "/api/accounts/password/verify": "password", "/log-in/password": "password",
        "/api/accounts/mfa/verify": "totp", "/mfa-challenge": "totp",
        "/api/accounts/workspace/select": "workspace", "/workspace": "workspace",
        "/api/accounts/session/select": "session", "/choose-an-account": "session",
        "/email-verification": "email",
    },
    "sentinel.openai.com": {SDK_PATH: "sentinel_sdk", "/backend-api/sentinel/req": "sentinel_request"},
}


def challenge_endpoint(url: str) -> str:
    try:
        u = parsed_url(url)
        if u.scheme != "https" or u.port not in (None, 443):
            return "unknown"
        path = u.path or "/"
        if u.hostname == "auth.openai.com" and AUTH_GET_PATH.fullmatch(path):
            path = path.rstrip("/")
            if path.startswith("/mfa-challenge/"):
                return "totp"
            if path == "/sign-in-with-chatgpt" or path.startswith("/sign-in-with-chatgpt/"):
                return "authorize"
        return CHALLENGE_PATHS.get(u.hostname, {}).get(path, "unknown")
    except LoginError:
        return "unknown"


class VerificationMarkup(HTMLParser):
    """Recognize an embedded verification control, not a mention/help link.

    Markup alone is not evidence that a login request was blocked by an access
    challenge. It may require human verification, so it must never permit retry.
    """
    def __init__(self):
        super().__init__()
        self.required = False

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if "cf-turnstile" in (attributes.get("class") or "").split():
            self.required = True
        if tag not in {"script", "iframe"}:
            return
        source = attributes.get("src") or ""
        try:
            url = urlsplit(source)
            if ((not url.netloc and url.path.startswith("/cdn-cgi/challenge-platform/"))
                    or (url.hostname == "challenges.cloudflare.com" and url.path.startswith(("/turnstile/", "/cdn-cgi/challenge-platform/")))):
                self.required = True
        except ValueError:
            pass


def check_response(response, failure_code="OAUTH_HTTP_REJECTED"):
    headers = {k.lower(): v for k, v in response.headers.items()}
    # Only the explicit access-challenge response marker authorizes a fresh
    # attempt. HTML references can be normal page assets or manual verification.
    if headers.get("cf-mitigated", "").lower() == "challenge":
        raise LoginError("OAUTH_HTTP_CHALLENGE", {
            "endpoint": challenge_endpoint(response.url), "status": response.status_code,
        })
    if response.status_code >= 400:
        raise LoginError(failure_code)
    if "text/html" in headers.get("content-type", "").lower():
        markup = VerificationMarkup()
        markup.feed(response.text[:65536])
        if markup.required:
            raise LoginError("OAUTH_VERIFICATION_REQUIRED")
    return response


def default_session(**kwargs):
    from curl_cffi import CurlOpt
    from curl_cffi.requests import Session
    # curl_cffi's trust_env flag alone does not set libcurl's NO_PROXY behavior.
    # An explicitly selected proxy must never be bypassed by ambient NO_PROXY.
    return Session(**kwargs, curl_options={CurlOpt.NOPROXY: ""})


class Transport:
    def __init__(self, proxy=None, timeout_ms=120000, session_factory=None):
        if session_factory is None:
            session_factory = default_session
        self.fingerprint = dict(FINGERPRINT)
        self.deadline = time.monotonic() + timeout_ms / 1000
        self.session = session_factory(impersonate=self.fingerprint["impersonate"],
                                       trust_env=False, verify=True, proxies={"all": proxy_url(proxy) or ""})
        self.cookies = self.session.cookies

    def request(self, method, url, **kwargs):
        method = method.upper()
        check_url(method, url)
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise LoginError("OAUTH_TIMEOUT")
        # Callers cannot override proxy, verification, redirects, timeout or streaming.
        if set(kwargs) - {"headers", "data", "json"}:
            raise LoginError("OAUTH_WORKER_PROTOCOL")
        chunks, size = [], 0

        def receive(chunk):
            nonlocal size
            size += len(chunk)
            if size > MAX_BODY:
                return 0
            chunks.append(chunk)
            return len(chunk)

        headers = {"User-Agent": self.fingerprint["user_agent"],
                   "Accept-Language": self.fingerprint["lang_full"], **kwargs.pop("headers", {})}
        try:
            raw = self.session.request(method, url, headers=headers, allow_redirects=False,
                                       timeout=min(30, remaining), content_callback=receive, **kwargs)
            if size > MAX_BODY:
                raise LoginError("OAUTH_HTTP_REJECTED")
            return Response(raw.status_code, {k.lower(): v for k, v in raw.headers.items()},
                            b"".join(chunks).decode("utf-8", errors="replace"), url)
        except LoginError:
            raise
        except Exception:
            raise LoginError("OAUTH_HTTP_REJECTED" if size > MAX_BODY else "OAUTH_NETWORK_ERROR") from None

    def close(self):
        self.session.close()
