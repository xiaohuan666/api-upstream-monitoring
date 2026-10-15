"""Exercise the installed pinned curl library against local fixtures, never OpenAI."""
import http.server
import os
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
from oauth_login.errors import LoginError
from oauth_login.transport import Transport


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.requests.append(self.path)
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/must-not-be-requested")
            self.end_headers()
        elif self.path == "/cookie":
            self.send_response(200)
            self.send_header("Set-Cookie", "fixture=memory; Path=/")
            self.end_headers()
        else:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"cookie":"' + self.headers.get("Cookie", "").encode() + b'"}')

    def log_message(self, *_):
        pass


class CurlTransportTests(unittest.TestCase):
    def test_real_curl_memory_cookies_no_redirect_no_ambient_proxy(self):
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.requests = []
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        root = f"http://127.0.0.1:{server.server_port}"
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        with patch.dict(os.environ, {"http_proxy": "http://127.0.0.1:1", "ALL_PROXY": "http://127.0.0.1:1", "NO_PROXY": "*"}), patch("oauth_login.transport.check_url", side_effect=lambda m, u: u):
            transport = Transport()
            self.addCleanup(transport.close)
            response = transport.request("GET", root + "/redirect")
            self.assertEqual(response.status_code, 302)
            self.assertEqual(response.headers["location"], "/must-not-be-requested")
            transport.request("GET", root + "/cookie")
            self.assertEqual(transport.request("GET", root + "/echo").json(), {"cookie": "fixture=memory"})
            self.assertNotIn("/must-not-be-requested", server.requests)
            # Even ambient NO_PROXY=* must not bypass the explicitly selected dead proxy.
            proxied = Transport({"protocol": "http", "host": "127.0.0.1", "port": 1})
            self.addCleanup(proxied.close)
            with self.assertRaisesRegex(LoginError, "^OAUTH_NETWORK_ERROR$"):
                proxied.request("GET", root + "/must-not-be-requested")
            self.assertNotIn("/must-not-be-requested", server.requests)


if __name__ == "__main__":
    unittest.main()
