"""Only fixed codes and bounded challenge diagnostics cross the process boundary."""

CHALLENGE_ENDPOINTS = frozenset({
    "warmup", "csrf", "web_signin", "web_session", "web_callback", "authorize",
    "password", "email", "totp", "workspace", "session", "sentinel_sdk",
    "sentinel_request", "unknown",
})


def sanitize_challenge(value: object) -> dict[str, str | int] | None:
    """Copy only the fixed endpoint label and an integer HTTP status."""
    if (type(value) is not dict or set(value) != {"endpoint", "status"}
            or type(value["endpoint"]) is not str or value["endpoint"] not in CHALLENGE_ENDPOINTS
            or type(value["status"]) is not int or not 100 <= value["status"] <= 599):
        return None
    return {"endpoint": value["endpoint"], "status": value["status"]}


class LoginError(Exception):
    def __init__(self, code: str, challenge: object = None) -> None:
        diagnostic = sanitize_challenge(challenge) if challenge is not None else None
        if challenge is not None and (code != "OAUTH_HTTP_CHALLENGE" or diagnostic is None):
            code = "OAUTH_WORKER_PROTOCOL"
            diagnostic = None
        self.code = code
        self.challenge = diagnostic
        super().__init__(code)

    def worker_event(self) -> dict:
        # Recheck at serialization: callers may have mutated an exception after creation.
        if self.challenge is not None:
            diagnostic = sanitize_challenge(self.challenge)
            if self.code != "OAUTH_HTTP_CHALLENGE" or diagnostic is None:
                return {"type": "error", "code": "OAUTH_WORKER_PROTOCOL"}
            return {"type": "error", "code": self.code, "challenge": diagnostic}
        return {"type": "error", "code": self.code}
