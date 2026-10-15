import json
import os
import subprocess
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
from oauth_login.errors import CHALLENGE_ENDPOINTS, LoginError
from oauth_login.transport import AUTH, CHAT, SDK_PATH, MAX_BODY, Transport, Response, check_url, check_response, proxy_url


class Session:
    def __init__(self, **kwargs):
        self.options, self.calls, self.cookies, self.closed = kwargs, [], SimpleNamespace(jar=[]), False
        self.body = b'{"ok":true}'
        self.fail = False

    def request(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if self.fail:
            raise RuntimeError("secret-password-and-query")
        kwargs["content_callback"](self.body)
        return SimpleNamespace(status_code=200, headers={"Content-Type": "application/json"})

    def close(self):
        self.closed = True


class TransportTests(unittest.TestCase):
    def test_one_verified_session_proxy_and_no_environment_fallback(self):
        proxy = {"protocol": "socks5h", "host": "::1", "port": "1080", "username": "u@x", "password": "p:/@"}
        t = Transport(proxy, session_factory=Session)
        self.assertEqual(t.session.options, {"impersonate": "safari18_0", "trust_env": False, "verify": True, "proxies": {"all": "socks5h://u%40x:p%3A%2F%40@[::1]:1080"}})
        self.assertEqual(t.request("GET", CHAT + "/api/auth/csrf").json(), {"ok": True})
        args = t.session.calls[0][1]
        self.assertFalse(args["allow_redirects"])
        self.assertLessEqual(args["timeout"], 30)
        t.close()
        self.assertTrue(t.session.closed)

    def test_body_limit_no_raw_error(self):
        t = Transport(session_factory=Session)
        t.session.body = b'x' * (MAX_BODY + 1)
        with self.assertRaisesRegex(LoginError, "^OAUTH_HTTP_REJECTED$"):
            t.request("GET", CHAT + "/")
        t.session.fail = True
        with self.assertRaisesRegex(LoginError, "^OAUTH_NETWORK_ERROR$"):
            t.request("GET", CHAT + "/")
        self.assertEqual(len(t.session.calls), 2)

    def test_no_redirect_proxy_tls_override(self):
        t = Transport(session_factory=Session)
        for kwargs in [{"verify": False}, {"allow_redirects": True}, {"proxy": "http://evil.test"}, {"timeout": 999}]:
            with self.assertRaisesRegex(LoginError, "^OAUTH_WORKER_PROTOCOL$"):
                t.request("GET", CHAT + "/", **kwargs)
        self.assertEqual(t.session.calls, [])

    def test_expired_deadline_does_not_issue_request(self):
        t = Transport(session_factory=Session)
        t.deadline = time.monotonic() - 1
        with self.assertRaisesRegex(LoginError, "^OAUTH_TIMEOUT$"):
            t.request("GET", CHAT + "/")
        self.assertEqual(t.session.calls, [])

    def test_exact_host_path_method_allowlist(self):
        allowed = [("GET", AUTH + "/oauth/authorize?state=x"), ("POST", AUTH + "/api/accounts/password/verify"), ("GET", "https://sentinel.openai.com" + SDK_PATH), ("POST", "https://sentinel.openai.com/backend-api/sentinel/req")]
        for method, url in allowed:
            self.assertEqual(check_url(method, url), url)
        rejected = [("POST", "https://sentinel.openai.com" + SDK_PATH), ("GET", "https://sentinel.openai.com/sentinel/other/sdk.js"), ("POST", AUTH + "/oauth/token"), ("POST", AUTH + "/api/accounts/register"), ("GET", "http://localhost:1455/auth/callback"), ("GET", "https://auth.openai.com:444/log-in"), ("GET", "https://evil.test/log-in"), ("GET", "https://auth.openai.com./log-in"), ("GET", "https://auth.openai.com/log-in#fragment"), ("GET", "https://auth.openai.com\\@evil.test/log-in"), ("GET", "https://auth.openai.com/%2flog-in"), ("GET", "https://u:p@auth.openai.com/log-in"), ("GET", "https://auth.openai.com/log-in\n")]
        for method, url in rejected:
            with self.subTest(url=url):
                with self.assertRaises(LoginError):
                    check_url(method, url)

    def test_web_authorize_entry_is_exact_get_only(self):
        url = AUTH + "/api/accounts/authorize?state=offline"
        self.assertEqual(check_url("GET", url), url)
        for method, rejected in [("POST", url), ("GET", AUTH + "/api/accounts/authorize/"),
                                 ("GET", AUTH + "/api/accounts/authorize-extra"),
                                 ("GET", url.replace("auth.openai.com", "auth.openai.com:444")),
                                 ("GET", url.replace("https://", "http://")),
                                 ("GET", url + "#fragment")]:
            with self.subTest(method=method, url=rejected):
                with self.assertRaisesRegex(LoginError, "^OAUTH_UNTRUSTED_ORIGIN$"):
                    check_url(method, rejected)

    def test_challenge_header_and_html_distinct_from_http_rejection(self):
        with self.assertRaisesRegex(LoginError, "^OAUTH_HTTP_CHALLENGE$"):
            check_response(Response(403, {"cf-mitigated": "challenge"}, "", ""))
        with self.assertRaisesRegex(LoginError, "^OAUTH_VERIFICATION_REQUIRED$"):
            check_response(Response(200, {"content-type": "text/html"}, "<script src='/cdn-cgi/challenge-platform/x'>", ""))
        with self.assertRaisesRegex(LoginError, "^OAUTH_HTTP_REJECTED$"):
            check_response(Response(403, {"content-type": "application/json"}, "{}", ""))

    def test_challenge_endpoint_status_and_secrets_are_bounded(self):
        endpoints = [
            (CHAT + "/", "warmup"), (CHAT + "/api/auth/csrf", "csrf"),
            (CHAT + "/api/auth/signin/openai", "web_signin"),
            (CHAT + "/api/auth/session", "web_session"),
            (CHAT + "/api/auth/callback/openai", "web_callback"),
            (AUTH + "/oauth/authorize", "authorize"), (AUTH + "/authorize/", "authorize"),
            (AUTH + "/api/accounts/authorize", "authorize"),
            (AUTH + "/sign-in-with-chatgpt/codex/consent", "authorize"),
            (AUTH + "/api/accounts/authorize/continue", "email"), (AUTH + "/log-in", "email"),
            (AUTH + "/api/accounts/password/verify", "password"), (AUTH + "/log-in/password", "password"),
            (AUTH + "/api/accounts/mfa/verify", "totp"), (AUTH + "/mfa-challenge/id-SECRET", "totp"),
            (AUTH + "/api/accounts/workspace/select", "workspace"), (AUTH + "/workspace/", "workspace"),
            (AUTH + "/api/accounts/session/select", "session"),
            ("https://sentinel.openai.com" + SDK_PATH, "sentinel_sdk"),
            ("https://sentinel.openai.com/backend-api/sentinel/req", "sentinel_request"),
            (AUTH + "/add-phone", "unknown"), ("https://evil.test/log-in", "unknown"),
            (AUTH + "/api/accounts/password/verify-SECRET", "unknown"),
            ("https://user:SECRET@auth.openai.com/log-in", "unknown"), ("bad-SECRET", "unknown"),
        ]
        for url, endpoint in endpoints:
            for status in (200, 302, 403, 429, 503):
                with self.subTest(url=url, status=status):
                    response = Response(status, {"CF-Mitigated": "ChAlLeNgE", "CF-Ray": "ray-SECRET",
                                                "Set-Cookie": "cookie-SECRET"}, "body-SECRET", url + "?token=query-SECRET")
                    with self.assertRaises(LoginError) as raised:
                        check_response(response, "OAUTH_INVALID_CREDENTIALS")
                    error = raised.exception
                    self.assertEqual(error.challenge, {"endpoint": endpoint, "status": status})
                    self.assertEqual(error.worker_event(), {"type": "error", "code": "OAUTH_HTTP_CHALLENGE",
                                                           "challenge": error.challenge})
                    self.assertEqual(str(error), "OAUTH_HTTP_CHALLENGE")
                    self.assertNotIn("SECRET", repr(vars(error)) + json.dumps(error.worker_event()))
                    self.assertIn(endpoint, CHALLENGE_ENDPOINTS)

    def test_markup_is_not_retry_evidence_and_does_not_override_credential_rejection(self):
        ordinary = ["<a href='https://challenges.cloudflare.com'>help</a>",
                    "<p>cf-chl- /cdn-cgi/challenge-platform challenges.cloudflare.com</p>",
                    "<script src='https://challenges.cloudflare.com.evil.invalid/turnstile/v0/api.js'></script>"]
        controls = ["<script src='https://challenges.cloudflare.com/turnstile/v0/api.js'></script>",
                    "<div class='example cf-turnstile' data-sitekey='PRIVATE'></div>",
                    "<iframe src='https://challenges.cloudflare.com/cdn-cgi/challenge-platform/widget'></iframe>",
                    "<script src='/cdn-cgi/challenge-platform/x'></script>"]
        for body in ordinary:
            response = Response(200, {"content-type": "text/html"}, body, AUTH + "/log-in")
            self.assertIs(check_response(response), response)
        for body in controls:
            with self.assertRaises(LoginError) as raised:
                check_response(Response(200, {"content-type": "TEXT/HTML"}, body, AUTH + "/log-in"))
            self.assertEqual(raised.exception.code, "OAUTH_VERIFICATION_REQUIRED")
            self.assertIsNone(raised.exception.challenge)
        for body in ordinary + controls + ['{"error":"bad password"}']:
            for status in [401, 403]:
                with self.assertRaises(LoginError) as raised:
                    check_response(Response(status, {"content-type": "text/html"}, body, AUTH + "/log-in/password"),
                                   "OAUTH_INVALID_CREDENTIALS")
                self.assertEqual(raised.exception.code, "OAUTH_INVALID_CREDENTIALS")
                self.assertIsNone(raised.exception.challenge)
        response = Response(200, {"content-type": "application/json"}, "cf-chl-", "")
        self.assertIs(check_response(response), response)

    def test_login_error_challenge_validation_and_serialization_revalidation(self):
        valid = {"endpoint": "password", "status": 403}
        error = LoginError("OAUTH_HTTP_CHALLENGE", valid)
        valid["endpoint"] = "SECRET"
        self.assertEqual(error.challenge, {"endpoint": "password", "status": 403})
        invalid = [{}, [], "SECRET", {"endpoint": "SECRET", "status": 403},
                   {"endpoint": "authorizing", "status": 403}, {"endpoint": "csrf", "status": True},
                   {"endpoint": "csrf", "status": "403"}, {"endpoint": "csrf", "status": 403.0},
                   {"endpoint": "csrf", "status": 99}, {"endpoint": "csrf", "status": 600},
                   {"endpoint": "csrf", "status": 403, "url": "SECRET"}]
        for diagnostic in invalid:
            error = LoginError("OAUTH_HTTP_CHALLENGE", diagnostic)
            self.assertEqual(error.worker_event(), {"type": "error", "code": "OAUTH_WORKER_PROTOCOL"})
        self.assertEqual(LoginError("OAUTH_HTTP_CHALLENGE").worker_event(),
                         {"type": "error", "code": "OAUTH_HTTP_CHALLENGE"})
        error = LoginError("OAUTH_INVALID_CREDENTIALS", {"endpoint": "password", "status": 403})
        self.assertEqual(error.worker_event(), {"type": "error", "code": "OAUTH_WORKER_PROTOCOL"})
        error = LoginError("OAUTH_HTTP_CHALLENGE", {"endpoint": "password", "status": 403})
        error.challenge["body"] = "SECRET"
        self.assertEqual(error.worker_event(), {"type": "error", "code": "OAUTH_WORKER_PROTOCOL"})
        error = LoginError("OAUTH_INVALID_CREDENTIALS")
        error.challenge = {"endpoint": "password", "status": 403}
        self.assertEqual(error.worker_event(), {"type": "error", "code": "OAUTH_WORKER_PROTOCOL"})

    def test_real_worker_challenge_ndjson_no_secrets_no_retry(self):
        from test_flow import INPUT
        worker = Path(__file__).resolve().parents[2] / "tools/oauth_login/worker.py"
        bootstrap = """
import sys
from types import SimpleNamespace
sys.path.insert(0, sys.argv[1])
from oauth_login import worker
from oauth_login.transport import Transport
class Session:
    cookies = SimpleNamespace(jar=[])
    def __init__(self, **kwargs):
        self.calls = 0
    def request(self, *args, **kwargs):
        self.calls += 1
        assert self.calls == 1, 'challenge must not retry'
        kwargs['content_callback'](b'<html>cf-chl- body-SECRET</html>')
        return SimpleNamespace(status_code=403, headers={'Content-Type': 'text/html', 'CF-Mitigated': 'challenge',
                              'CF-Ray': 'ray-SECRET', 'Set-Cookie': 'cookie-SECRET'})
    def close(self):
        pass
worker.Transport = lambda *args: Transport(*args, session_factory=Session)
sys.exit(worker.main())
"""
        proc = subprocess.run([sys.executable, "-c", bootstrap, str(worker.parents[1])],
                              input=(json.dumps(INPUT) + '\n{"type":"ack","stage":"warmup"}\n').encode(),
                              capture_output=True, timeout=5)
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(proc.stderr, b'')
        self.assertEqual([json.loads(line) for line in proc.stdout.splitlines()], [
            {"type": "stage", "stage": "warmup"},
            {"type": "error", "code": "OAUTH_HTTP_CHALLENGE", "challenge": {"endpoint": "warmup", "status": 403}},
        ])
        for secret in ["SECRET", INPUT["email"], INPUT["password"], INPUT["totpSecret"], INPUT["authUrl"]]:
            self.assertNotIn(secret.encode(), proc.stdout + proc.stderr)

    def test_invalid_proxy(self):
        for proxy in [{"protocol": "ftp", "host": "a", "port": 1}, {"protocol": "http", "host": "a@evil", "port": 1}, {"protocol": "http", "host": "a", "port": 0}, {"protocol": "http", "host": "a", "port": 1, "username": 8}]:
            with self.assertRaises(LoginError):
                proxy_url(proxy)

    def test_real_worker_waits_for_stage_ack_before_any_http(self):
        from test_flow import INPUT
        worker = Path(__file__).resolve().parents[2] / "tools/oauth_login/worker.py"
        proc = subprocess.Popen([sys.executable, "-u", str(worker)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            proc.stdin.write((json.dumps(INPUT) + "\n").encode())
            proc.stdin.flush()
            self.assertEqual(json.loads(proc.stdout.readline()), {"type": "stage", "stage": "warmup"})
            self.assertIsNone(proc.poll())
            output, stderr = proc.communicate(b'{"type":"ack","stage":"wrong"}\n', timeout=5)
            self.assertEqual(json.loads(output), {"type": "error", "code": "OAUTH_ABORTED"})
            self.assertEqual(stderr, b'')
            self.assertEqual(proc.returncode, 1)
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.wait()
            for pipe in (proc.stdin, proc.stdout, proc.stderr):
                pipe.close()

    def test_real_worker_invalid_stdin_is_redacted(self):
        worker = Path(__file__).resolve().parents[2] / "tools/oauth_login/worker.py"
        for value in [b'PASSWORD-SECRET-invalid-json', b'x' * 65537, b'{}']:
            proc = subprocess.run([sys.executable, str(worker)], input=value, capture_output=True, timeout=5)
            self.assertEqual(proc.returncode, 1)
            self.assertEqual(proc.stderr, b'')
            event = json.loads(proc.stdout)
            self.assertEqual(set(event), {"type", "code"})
            self.assertEqual(event["type"], "error")
            self.assertNotIn(b'PASSWORD-SECRET', proc.stdout)


if __name__ == "__main__":
    unittest.main()
