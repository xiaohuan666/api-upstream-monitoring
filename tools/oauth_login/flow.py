"""Existing-account HTTP state machine adapted from any-auto-register@44c27a8.

The application, not this worker, owns the final PKCE verifier. No registration,
password guessing, mailbox polling, token exchange, or arbitrary form submission.
"""
import re
import uuid
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit

from .errors import LoginError
from .protocol_json import decode_json
from .workspaces import select_workspace
from .totp import normalize_secret, totp_now
from .transport import AUTH, CHAT, check_response, check_url, parsed_url

REDIRECTS = {"http://localhost:1455/auth/callback", "http://127.0.0.1:1455/auth/callback"}
REDIRECT_CODES = {301, 302, 303, 307, 308}
TARGET_AUTHORIZE_PATHS = {"/oauth/authorize", "/authorize"}
# ChatGPT's signin endpoint can return its web-only accounts entry. The target
# Sub2 transaction retains its original narrower authorize contract.
WEB_AUTHORIZE_PATHS = TARGET_AUTHORIZE_PATHS | {"/api/accounts/authorize"}


def single(query, key, max_length=8192):
    values = query.get(key, [])
    if len(values) != 1 or not isinstance(values[0], str) or not values[0] or len(values[0]) > max_length or re.search(r"[\s\x00-\x1f\x7f]", values[0]):
        raise LoginError("OAUTH_INVALID_CALLBACK")
    return values[0]


def auth_contract(url, web=False):
    try:
        check_url("GET", url)
        u = parsed_url(url)
        if u.hostname != "auth.openai.com" or u.path not in (WEB_AUTHORIZE_PATHS if web else TARGET_AUTHORIZE_PATHS):
            raise ValueError()
        query = parse_qs(u.query, keep_blank_values=True)
        state, redirect = single(query, "state", 1024), single(query, "redirect_uri")
        allowed = {CHAT + "/api/auth/callback/openai"} if web else REDIRECTS
        if redirect not in allowed or single(query, "response_type") != "code":
            raise ValueError()
        return {"state": state, "redirectUri": redirect}
    except (ValueError, LoginError):
        raise LoginError("OAUTH_INVALID_AUTH_URL") from None


def callback(url, contract):
    try:
        u = parsed_url(url)
        if u.scheme + "://" + u.netloc + u.path != contract["redirectUri"]:
            raise LoginError("OAUTH_INVALID_CALLBACK")
        query = parse_qs(u.query, keep_blank_values=True)
        if single(query, "state", 1024) != contract["state"]:
            raise LoginError("OAUTH_STATE_MISMATCH")
        if "error" in query:
            raise LoginError("OAUTH_CALLBACK_ERROR")
        return {"code": single(query, "code"), **contract}
    except ValueError:
        raise LoginError("OAUTH_INVALID_CALLBACK") from None


def json_object(response, error_code="OAUTH_UNKNOWN_STEP"):
    try:
        result = decode_json(response.text, error_code)
        if not isinstance(result, dict):
            raise ValueError()
        return result
    except (ValueError, TypeError):
        raise LoginError(error_code) from None


def step_info(data):
    page = data.get("page") if isinstance(data.get("page"), dict) else {}
    payload = page.get("payload") if isinstance(page.get("payload"), dict) else {}
    kind = str(page.get("type") or "").lower().replace("-", "_")
    target = data.get("continue_url") or (payload.get("url") if kind == "external_url" else "") or ""
    if not isinstance(target, str):
        raise LoginError("OAUTH_UNKNOWN_STEP")
    return kind, payload, target


class LoginFlow:
    def __init__(self, transport, sentinel, emit):
        self.transport, self.sentinel, self.emit = transport, sentinel, emit
        self.device_id = ""
        self.tokens = ("", "")

    def stage(self, stage):
        self.emit({"type": "stage", "stage": stage})

    def cookie(self, name, host):
        # A conflicting cookie must never silently select a different session.
        values = set()
        for c in self.transport.cookies.jar:
            domain = c.domain.lstrip(".")
            if c.name == name and (host == domain or host.endswith("." + domain)):
                values.add(c.value)
        if len(values) > 1:
            raise LoginError("OAUTH_UNKNOWN_STEP")
        return next(iter(values), "")

    def navigation(self, url, referer):
        response = self.transport.request("GET", url, headers={
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Referer": referer, "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "same-origin" if urlsplit(url).netloc == urlsplit(referer).netloc else "cross-site",
        })
        return check_response(response)

    def post(self, path, body, referer, error="OAUTH_HTTP_REJECTED"):
        headers = {"Content-Type": "application/json", "Accept": "application/json",
                   "Origin": AUTH, "Referer": referer, "oai-device-id": self.device_id,
                   "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin"}
        for key, value in zip(("openai-sentinel-token", "openai-sentinel-so-token"), self.tokens):
            if value:
                headers[key] = value
        response = check_response(self.transport.request("POST", AUTH + path, headers=headers, json=body), error)
        if response.status_code in REDIRECT_CODES:
            # Never replay credential-bearing POST through a redirect (307/308).
            if response.status_code not in {301, 302, 303}:
                raise LoginError("OAUTH_INVALID_CALLBACK")
            location = response.headers.get("location")
            if not location:
                raise LoginError("OAUTH_UNKNOWN_STEP")
            return {"continue_url": urljoin(AUTH + path, location)}
        if response.status_code != 200:
            raise LoginError("OAUTH_HTTP_REJECTED")
        return json_object(response, "OAUTH_WORKSPACE_INVALID" if path == "/api/accounts/workspace/select" else "OAUTH_UNKNOWN_STEP")

    def sentinel_tokens(self):
        try:
            tokens = self.sentinel(self.transport, self.device_id, "authorize_continue")
            if not isinstance(tokens, tuple) or len(tokens) != 2 or not tokens[0] or any(not isinstance(t, str) or len(t) > 262144 or re.search(r"[\r\n\x00]", t) for t in tokens):
                raise ValueError()
            self.tokens = tokens
        except LoginError:
            raise
        except Exception:
            raise LoginError("OAUTH_SENTINEL_FAILED") from None

    def workspace(self, data, html=""):
        try:
            encoded = self.cookie("oai-client-auth-session", "auth.openai.com")
        except LoginError:
            raise LoginError("OAUTH_WORKSPACE_CONFLICT") from None
        return select_workspace(data, html, encoded)

    def account_session(self, data, html):
        # A fresh task never imports other users' sessions. Still, only select a
        # unique server-advertised session; final Web/token identity is checked.
        candidates = set(re.findall(r"\bus_[A-Za-z0-9_-]{16,128}\b", html))
        page = data.get("page") if isinstance(data.get("page"), dict) else {}
        payload = page.get("payload") if isinstance(page.get("payload"), dict) else {}
        for doc in (data, payload):
            for session in doc.get("unified_sessions", []) if isinstance(doc.get("unified_sessions"), list) else []:
                if isinstance(session, dict) and isinstance(session.get("id"), str):
                    candidates.add(session["id"])
        if len(candidates) != 1:
            raise LoginError("OAUTH_ACCOUNT_SELECTION_REQUIRED")
        selected = candidates.pop()
        if not re.fullmatch(r"us_[A-Za-z0-9_-]{16,128}", selected):
            raise LoginError("OAUTH_ACCOUNT_SELECTION_REQUIRED")
        return selected

    def drive(self, start, credentials, contract, web=False):
        current, referer, data = start, CHAT + "/", None
        posted, visited = set(), set()
        revision = 0
        consumed_web_callback = False
        html = ""
        self.tokens = ("", "")
        for _ in range(32):
            kind, payload, target = step_info(data or {})
            if target:
                current = urljoin(AUTH + "/", target)
            u = parsed_url(current)
            base = u.scheme + "://" + u.netloc + u.path
            if u.scheme != "https" or u.hostname in {"localhost", "127.0.0.1", "::1"}:
                # A web-auth chain must not steal the final Sub2 callback/state.
                if web:
                    raise LoginError("OAUTH_INVALID_CALLBACK")
                return callback(current, contract)
            # Special completion branches obey the same scheme/host/port policy.
            check_url("GET", current)
            if base == CHAT + "/api/auth/callback/openai":
                if not web or consumed_web_callback:
                    raise LoginError("OAUTH_INVALID_CALLBACK")
                callback(current, contract)
                response = self.navigation(current, referer)
                consumed_web_callback = True
                if response.status_code in REDIRECT_CODES:
                    location = response.headers.get("location")
                    if not location:
                        raise LoginError("OAUTH_UNKNOWN_STEP")
                    referer, current, data = current, urljoin(current, location), None
                    continue
                if response.status_code == 200:
                    return None
                raise LoginError("OAUTH_HTTP_REJECTED")
            elif u.hostname == "chatgpt.com":
                if not web or not consumed_web_callback or u.path != "/":
                    raise LoginError("OAUTH_UNKNOWN_STEP")
                return None
            else:
                check_url("GET", current)

            if data is not None and target and kind in {"", "external_url"}:
                data = None
                continue
            path = u.path.rstrip("/")
            # Only derive an actionable step from protocol data or a loaded page.
            if data is None:
                if (revision, current) in visited:
                    raise LoginError("OAUTH_UNKNOWN_STEP")
                visited.add((revision, current))
                response = self.navigation(current, referer)
                if response.status_code in REDIRECT_CODES:
                    location = response.headers.get("location")
                    if not location:
                        raise LoginError("OAUTH_UNKNOWN_STEP")
                    referer, current = current, urljoin(current, location)
                    continue
                if response.status_code != 200:
                    raise LoginError("OAUTH_HTTP_REJECTED")
                if "application/json" in response.headers.get("content-type", ""):
                    workspace_page = path in {"/workspace", "/consent"} or path.startswith("/sign-in-with-chatgpt/")
                    data = json_object(response, "OAUTH_WORKSPACE_INVALID" if workspace_page else "OAUTH_UNKNOWN_STEP")
                    continue
                data = {}
                html = response.text
                if consumed_web_callback:
                    raise LoginError("OAUTH_UNKNOWN_STEP")

            kind, payload, _ = step_info(data)
            if kind in {"email_otp_verification", "email_verification"} or path == "/email-verification":
                raise LoginError("OAUTH_EMAIL_OTP_REQUIRED")
            if "phone" in kind or "phone" in path:
                raise LoginError("OAUTH_PHONE_REQUIRED")
            if kind in {"choose_an_account", "account_selection"} or path == "/choose-an-account":
                action = "account"
            elif kind in {"login_password", "password"} or path == "/log-in/password":
                action = "password"
            elif kind in {"mfa_challenge", "totp"} or path.startswith("/mfa-challenge"):
                action = "totp"
            elif kind in {"workspace", "workspace_selection", "consent"} or path in {"/workspace", "/consent"} or path.startswith("/sign-in-with-chatgpt/"):
                action = "consent"
            elif kind in {"login", "login_or_signup", "identifier"} or path in {"/log-in", "/login"}:
                action = "email"
            elif target:
                data = None
                continue
            else:
                raise LoginError("OAUTH_UNKNOWN_STEP")
            if action in posted:
                raise LoginError("OAUTH_UNKNOWN_STEP")
            posted.add(action)
            self.stage("consent" if action == "account" else action)
            if action in {"email", "password"} and not self.tokens[0]:
                self.sentinel_tokens()
            if action == "account":
                data = self.post("/api/accounts/session/select", {"session_id": self.account_session(data, html)}, AUTH + "/choose-an-account")
            elif action == "email":
                data = self.post("/api/accounts/authorize/continue", {"username": {"value": credentials["email"], "kind": "email"}, "screen_hint": "login"}, AUTH + "/log-in")
            elif action == "password":
                data = self.post("/api/accounts/password/verify", {"password": credentials["password"]}, AUTH + "/log-in/password", "OAUTH_INVALID_CREDENTIALS")
            elif action == "totp":
                if not credentials.get("totpSecret"):
                    raise LoginError("OAUTH_TOTP_REQUIRED")
                challenge = payload.get("challenge_id") or (path.rsplit("/", 1)[-1] if path.startswith("/mfa-challenge/") else "")
                if not isinstance(challenge, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", challenge):
                    raise LoginError("OAUTH_UNKNOWN_STEP")
                data = self.post("/api/accounts/mfa/verify", {"code": totp_now(credentials["totpSecret"]), "type": "totp", "id": challenge}, AUTH + "/mfa-challenge", "OAUTH_TOTP_REJECTED")
            else:
                data = self.post("/api/accounts/workspace/select", {"workspace_id": self.workspace(data, html)}, AUTH + "/sign-in-with-chatgpt/codex/consent")
            # Successful protocol mutations can legitimately return to the same
            # authorization URL with new cookies; POST actions remain single-shot.
            revision += 1
            html = ""
            if action == "account" and data == {}:
                # Reference session/select may return only Set-Cookie + HTTP200.
                # One re-entry into this exact transaction, not a credential retry.
                current, data = start, None
                continue
            # Protocol pages can omit a URL when page.type fully specifies the next step.
            next_kind, _, next_target = step_info(data)
            if not next_target:
                paths = {"login_password": "/log-in/password", "mfa_challenge": "/mfa-challenge",
                         "email_otp_verification": "/email-verification", "consent": "/consent", "workspace_selection": "/workspace"}
                if next_kind not in paths:
                    raise LoginError("OAUTH_UNKNOWN_STEP")
                current = AUTH + paths[next_kind]
        raise LoginError("OAUTH_UNKNOWN_STEP")

    def run(self, credentials):
        target = auth_contract(credentials["authUrl"])
        self.stage("warmup")
        response = self.navigation(CHAT + "/", CHAT + "/")
        if response.status_code != 200:
            raise LoginError("OAUTH_HTTP_REJECTED")
        self.device_id = self.cookie("oai-did", "chatgpt.com")
        if not self.device_id or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", self.device_id):
            raise LoginError("OAUTH_UNKNOWN_STEP")
        self.stage("csrf")
        csrf = json_object(check_response(self.transport.request("GET", CHAT + "/api/auth/csrf", headers={"Accept": "application/json", "Referer": CHAT + "/"}))).get("csrfToken")
        if not isinstance(csrf, str) or not csrf or len(csrf) > 8192:
            raise LoginError("OAUTH_UNKNOWN_STEP")
        query = urlencode({"prompt": "login", "screen_hint": "login_or_signup", "ext-oai-did": self.device_id,
                           "auth_session_logging_id": str(uuid.uuid4()), "ext-passkey-client-capabilities": "1111", "login_hint": credentials["email"]})
        signin = check_response(self.transport.request("POST", CHAT + "/api/auth/signin/openai?" + query,
            headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded", "Origin": CHAT, "Referer": CHAT + "/"},
            data={"csrfToken": csrf, "callbackUrl": CHAT + "/", "json": "true"}))
        web_url = json_object(signin).get("url")
        web_contract = auth_contract(web_url, web=True)
        self.stage("authorizing")
        self.drive(web_url, credentials, web_contract, web=True)
        session = json_object(check_response(self.transport.request("GET", CHAT + "/api/auth/session", headers={"Accept": "application/json", "Referer": CHAT + "/"})))
        user = session.get("user") if isinstance(session.get("user"), dict) else {}
        if not isinstance(user.get("email"), str) or user["email"].strip().lower() != credentials["email"].strip().lower():
            raise LoginError("OAUTH_INVALID_CREDENTIALS")
        # Never replace the target URL's state, redirect, challenge or client_id.
        self.stage("authorizing")
        return self.drive(credentials["authUrl"], credentials, target)


def validate_input(data):
    if not isinstance(data, dict):
        raise LoginError("OAUTH_INVALID_INPUT")
    auth_contract(data.get("authUrl"))
    email, password = data.get("email"), data.get("password")
    timeout = data.get("timeoutMs", 120000)
    if not isinstance(email, str) or len(email) > 320 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) or not isinstance(password, str) or not 1 <= len(password) <= 4096 or type(timeout) is not int or not 1 <= timeout <= 300000:
        raise LoginError("OAUTH_INVALID_INPUT")
    if data.get("totpSecret"):
        data["totpSecret"] = normalize_secret(data["totpSecret"])
    return data
