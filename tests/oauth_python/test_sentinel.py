"""Offline tests only: mock SDK, no accounts and no external HTTP/login calls."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

from tools.oauth_login import sentinel as s
from tools.oauth_login.errors import LoginError
from tools.oauth_login.transport import FINGERPRINT, Response

MOCK_SDK = r"""
var SentinelSDK={
  init:async function(flow){
    const frame=document.createElement('iframe');
    frame.contentWindow.postMessage({p:'MOCK-PROOF',requestId:'init'},'https://sentinel.openai.com');
  },
  token:async function(flow){
    const result=await new Promise(resolve=>{
      addEventListener('message', event=>resolve(event.data.result));
      document.createElement('iframe').contentWindow.postMessage(
        {p:'MOCK-PROOF',requestId:'solve'},'https://sentinel.openai.com');
    });
    if(result.cachedChatReq.token!=='MOCK-CHALLENGE'||result.cachedProof!=='MOCK-PROOF')
      throw new Error('mock exchange mismatch');
    return 'MOCK-TOKEN';
  },
  sessionObserverToken:async()=> 'MOCK-SO'
};
"""


class MockTransport:
    def __init__(self, challenge=None, sdk=MOCK_SDK):
        self.fingerprint = {**FINGERPRINT, "proxy": "DO-NOT-FORWARD", "password": "DO-NOT-FORWARD"}
        self.deadline = time.monotonic() + 120
        self.sdk = sdk
        self.challenge = challenge if challenge is not None else {"token": "MOCK-CHALLENGE"}
        self.calls = []
        self.responses = {}

    def request(self, method, url, **kwargs):
        if set(kwargs) - {"headers", "data", "json"}:
            raise AssertionError("nonconforming transport kwargs")
        self.calls.append((method, url, kwargs, self.deadline))
        if url in self.responses:
            value = self.responses[url]
            if isinstance(value, Exception):
                raise value
            return value
        text = self.sdk if method == "GET" else json.dumps(self.challenge)
        return Response(200, {}, text, url)


class SentinelContractTests(unittest.TestCase):
    def setUp(self):
        self.transport = MockTransport()
        self.node_patch = patch.object(s, "_node_binary", return_value="/mock/node")
        self.node_patch.start()
        self.addCleanup(self.node_patch.stop)
        self.action_patch = patch.object(s, "_run_action", side_effect=[
            {"request_p": "MOCK-PROOF"}, {"token": "MOCK-TOKEN", "so_token": ""}])
        self.action = self.action_patch.start()
        self.addCleanup(self.action_patch.stop)

    def tokens(self):
        return s.get_tokens(self.transport, "mock-device", "authorize_continue")

    def test_two_exact_urls_same_transport_and_deadline_restored(self):
        before = self.transport.deadline
        self.assertEqual(self.tokens(), ("MOCK-TOKEN", ""))
        self.assertEqual([(c[0], c[1]) for c in self.transport.calls],
                         [("GET", s.SDK_URL), ("POST", s.REQ_URL)])
        self.assertEqual(s.SDK_URL, "https://sentinel.openai.com/sentinel/20260219f9f6/sdk.js")
        self.assertEqual(self.transport.deadline, before)
        self.assertTrue(all(c[3] <= time.monotonic() + s.HTTP_TIMEOUT for c in self.transport.calls))
        data = json.loads(self.transport.calls[1][2]["data"])
        self.assertEqual(data, {"p": "MOCK-PROOF", "id": "mock-device", "flow": "authorize_continue"})
        self.assertEqual(self.transport.calls[0][2]["headers"]["User-Agent"], FINGERPRINT["user_agent"])
        self.assertEqual(self.transport.calls[1][2]["headers"]["content-type"], "text/plain;charset=UTF-8")

    def test_fingerprint_allowlist_no_credentials(self):
        self.tokens()
        payload = self.action.call_args_list[0].args[3]
        self.assertNotIn("proxy", payload)
        self.assertNotIn("password", payload)
        self.assertNotIn("DO-NOT-FORWARD", json.dumps(payload))
        self.assertEqual(payload["platform"], "MacIntel")
        self.assertEqual(payload["vendor"], "Apple Computer, Inc.")
        self.assertEqual(payload["languages"], ["en-US", "en"])
        self.assertNotIn("device_memory", payload)

    def test_required_so(self):
        self.transport.challenge["so"] = {"required": True, "collector_dx": "mock"}
        self.action.side_effect = [{"request_p": "MOCK-PROOF"}, {"token": "MOCK-TOKEN", "so_token": "MOCK-SO"}]
        self.assertEqual(self.tokens(), ("MOCK-TOKEN", "MOCK-SO"))

    def test_required_so_missing_fails(self):
        self.transport.challenge["so"] = {"required": True}
        with self.assertRaises(s.SentinelError):
            self.tokens()

    def test_not_required_so_discarded(self):
        self.action.side_effect = [{"request_p": "MOCK-PROOF"}, {"token": "MOCK-TOKEN", "so_token": "OLD-FLOW-SO"}]
        self.assertEqual(self.tokens(), ("MOCK-TOKEN", ""))

    def test_required_not_coerced(self):
        for so in ({"required": "true"}, {"required": 1}, "mock", []):
            with self.subTest(so=so):
                self.transport.challenge["so"] = so
                self.action.side_effect = [{"request_p": "MOCK-PROOF"}]
                with self.assertRaises(s.SentinelError):
                    self.tokens()

    def test_no_missing_main_token_fallback(self):
        for token in (None, "", "   ", 123, {}, "x" * (s.MAX_TOKEN_BYTES + 1)):
            with self.subTest(token_type=type(token).__name__):
                self.action.side_effect = [{"request_p": "MOCK-PROOF"}, {"token": token, "so_token": ""}]
                with self.assertRaises(s.SentinelError):
                    self.tokens()

    def test_missing_proof_no_challenge_request(self):
        self.action.side_effect = [{"request_p": ""}]
        with self.assertRaises(s.SentinelError):
            self.tokens()
        self.assertEqual(len(self.transport.calls), 1)

    def test_missing_challenge_token(self):
        self.transport.challenge = {}
        with self.assertRaises(s.SentinelError):
            self.tokens()
        self.assertEqual(self.action.call_count, 1)

    def test_invalid_challenge_json_and_nonobject(self):
        for text in ("no-json", "[]", "null", '"mock"'):
            with self.subTest(text=text):
                self.transport.responses[s.REQ_URL] = Response(200, {}, text, s.REQ_URL)
                self.action.side_effect = [{"request_p": "MOCK-PROOF"}]
                with self.assertRaises(s.SentinelError):
                    self.tokens()

    def test_no_redirect_following(self):
        for url in (s.SDK_URL, s.REQ_URL):
            with self.subTest(url=url):
                self.transport.responses = {url: Response(302, {"location": "https://evil.invalid/"}, "", url)}
                self.action.side_effect = [{"request_p": "MOCK-PROOF"}]
                with self.assertRaises(s.SentinelError):
                    self.tokens()
                self.assertNotIn("https://evil.invalid/", [c[1] for c in self.transport.calls])

    def test_wrong_response_url(self):
        self.transport.responses[s.SDK_URL] = Response(200, {}, MOCK_SDK, "https://evil.invalid/")
        with self.assertRaises(s.SentinelError):
            self.tokens()

    def test_http_challenge_header_preserved(self):
        self.transport.responses[s.SDK_URL] = Response(403, {"cf-mitigated": "challenge"}, "", s.SDK_URL)
        with self.assertRaises(LoginError) as caught:
            self.tokens()
        self.assertEqual(caught.exception.code, "OAUTH_HTTP_CHALLENGE")

    def test_manual_verification_is_preserved_without_retry_classification(self):
        self.transport.responses[s.SDK_URL] = Response(200, {"content-type": "text/html"},
                                                      "<script src='/cdn-cgi/challenge-platform/x'></script>", s.SDK_URL)
        with self.assertRaises(LoginError) as caught:
            self.tokens()
        self.assertEqual(caught.exception.code, "OAUTH_VERIFICATION_REQUIRED")

    def test_transport_http_challenge_identity(self):
        error = LoginError("OAUTH_HTTP_CHALLENGE")
        self.transport.responses[s.SDK_URL] = error
        before = self.transport.deadline
        with self.assertRaises(LoginError) as caught:
            self.tokens()
        self.assertIs(caught.exception, error)
        self.assertEqual(self.transport.deadline, before)

    def test_other_transport_errors_sanitized(self):
        for error in (RuntimeError("password=MOCK-SECRET proxy=MOCK-SECRET"),
                      LoginError("OAUTH_NETWORK_ERROR")):
            with self.subTest(error_type=type(error).__name__):
                self.transport.responses[s.SDK_URL] = error
                with self.assertRaises(s.SentinelError) as caught:
                    self.tokens()
                self.assertNotIn("MOCK-SECRET", str(caught.exception))
                self.assertTrue(caught.exception.__suppress_context__)

    def test_sdk_and_challenge_limits(self):
        self.transport.sdk = "x" * (s.MAX_SDK_BYTES + 1)
        with self.assertRaises(s.SentinelError):
            self.tokens()
        self.assertEqual(self.action.call_count, 0)
        self.transport.sdk = MOCK_SDK
        self.transport.responses[s.REQ_URL] = Response(200, {}, "x" * (s.MAX_CHALLENGE_BYTES + 1), s.REQ_URL)
        with self.assertRaises(s.SentinelError):
            self.tokens()

    def test_expired_transport_before_http(self):
        self.transport.deadline = time.monotonic() - 1
        self.node_patch.stop()
        with self.assertRaises(s.SentinelError):
            self.tokens()
        self.assertEqual(self.transport.calls, [])
        self.node_patch.start()

    def test_invalid_inputs_and_fingerprint(self):
        for did, flow in (("", "authorize_continue"), ("mock", "../../evil"),
                          ("mock\nsecret", "authorize_continue")):
            with self.subTest(did=did, flow=flow), self.assertRaises(s.SentinelError):
                s.get_tokens(self.transport, did, flow)
        for key, value in (("screen", "bad"), ("hardware_concurrency", True),
                           ("device_pixel_ratio", float("nan")), ("lang_full", "en\r\nsecret")):
            with self.subTest(key=key):
                transport = MockTransport()
                transport.fingerprint[key] = value
                with self.assertRaises(s.SentinelError):
                    s.get_tokens(transport, "mock", "authorize_continue")

    def test_untrusted_internal_request(self):
        with self.assertRaises(s.SentinelError):
            s._request(self.transport, "GET", "https://evil.invalid/", time.monotonic() + 1)
        self.assertFalse(self.transport.calls)

    def test_runtime_protocol_exact_not_guessed(self):
        self.action_patch.stop()
        for result in (b'{}', b'{"final_p":"invented","t":null}', b'[]', b'not-json',
                       b'{"token":"MOCK","so_token":"","trace":"secret"}'):
            with self.subTest(result=result), patch.object(s, "_run_process", return_value=result):
                with self.assertRaises(s.SentinelError):
                    s._run_action("/mock/node", "solve", MOCK_SDK, {}, time.monotonic() + 1)


class RuntimePolicyTests(unittest.TestCase):
    def test_old_node_rejected(self):
        with patch.object(s.shutil, "which", return_value="/mock/node"), \
             patch.object(s, "_run_process", return_value=b"v20.20.0\n"):
            with self.assertRaises(s.SentinelError):
                s._node_binary(time.monotonic() + 1)

    def test_missing_node_rejected(self):
        with patch.object(s.shutil, "which", return_value=None):
            with self.assertRaises(s.SentinelError):
                s._node_binary(time.monotonic() + 1)

    def test_unsupported_os_no_bare_execution(self):
        with patch.object(s.sys, "platform", "unknown"):
            with self.assertRaises(s.SentinelError):
                s._isolated_command("/mock/node", ["--version"])

    def test_linux_uses_fixed_isolation_launcher(self):
        with patch.object(s.sys, "platform", "linux"):
            command = s._isolated_command("/mock/node", [str(s._RUNNER)])
        self.assertEqual(command[:4], [sys.executable, "-I", "-B", str(s._OS_LAUNCHER)])

    def test_isolation_failure_stops_before_http(self):
        transport = MockTransport()
        with patch.object(s, "_run_process", side_effect=s.SentinelError("Sentinel subprocess failed")):
            with self.assertRaises(s.SentinelError):
                s.get_tokens(transport, "mock-device", "authorize_continue")
        self.assertEqual(transport.calls, [])

    def test_linux_unknown_arch_fails_before_exec(self):
        spec = importlib.util.spec_from_file_location("sentinel_isolation_test", s._OS_LAUNCHER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with patch.object(module.sys, "platform", "linux"), \
             patch.object(module.platform, "machine", return_value="unknown"), \
             patch.object(module.resource, "setrlimit"), patch.object(module.os, "execv") as execute:
            with self.assertRaises(RuntimeError):
                module.main()
        execute.assert_not_called()

    def test_command_only_fixed_runner_fs_grant(self):
        command = s._isolated_command("/mock/node", [str(s._RUNNER)])
        self.assertIn("--permission", command)
        self.assertEqual([x for x in command if x.startswith("--allow")], [f"--allow-fs-read={s._RUNNER}"])
        self.assertNotIn("*", " ".join(x for x in command if x.startswith("--allow")))

    def test_subprocess_environment_only_path(self):
        actual = subprocess.Popen
        seen = []
        def capture(*args, **kwargs):
            seen.append(kwargs)
            return actual(*args, **kwargs)
        node = s._node_binary(time.monotonic() + 5)
        with patch.dict(os.environ, {"SENTINEL_TEST_SECRET": "MOCK-SECRET", "NODE_OPTIONS": "--invalid", "HTTPS_PROXY": "MOCK-SECRET"}), \
             patch.object(s.subprocess, "Popen", side_effect=capture):
            s._run_action(node, "requirements", MOCK_SDK, {"flow": "authorize_continue"}, time.monotonic() + 5)
        self.assertEqual(set(seen[0]["env"]), {"PATH"})
        self.assertNotIn("MOCK-SECRET", " ".join(seen[0]["env"].values()))
        self.assertNotIn("MOCK-SECRET", str(seen[0]))


@unittest.skipUnless(shutil.which("node") and sys.platform in {"darwin", "linux"}, "Node/OS isolation not available")
class RealNodeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # If Node exists but permission/isolation is broken, fail (do not skip).
        cls.node = s._node_binary(time.monotonic() + 5)

    def action(self, sdk, action="requirements", timeout=5, **payload):
        return s._run_action(self.node, action, sdk, {"flow": "authorize_continue", **payload},
                             time.monotonic() + timeout)

    def test_end_to_end_mock_transport_sdk(self):
        self.assertEqual(s.get_tokens(MockTransport(), "mock-device", "authorize_continue"), ("MOCK-TOKEN", ""))

    def test_end_to_end_mock_so(self):
        self.assertEqual(s.get_tokens(MockTransport({"token": "MOCK-CHALLENGE", "so": {"required": True}}),
                                      "mock-device", "authorize_continue"), ("MOCK-TOKEN", "MOCK-SO"))

    def test_missing_sdk_api_fails_not_fallback(self):
        for sdk in ("var SentinelSDK={init:async()=>{}};", "var SentinelSDK={};", "throw Error('MOCK-SECRET');"):
            with self.subTest(sdk=sdk), self.assertRaises(s.SentinelError) as caught:
                self.action(sdk)
            self.assertNotIn("MOCK-SECRET", str(caught.exception))

    def test_sdk_empty_token_and_required_so_fail(self):
        for sdk in (MOCK_SDK.replace("return 'MOCK-TOKEN';", "return '';"),
                    MOCK_SDK.replace("async()=> 'MOCK-SO'", "async()=> ''")):
            transport = MockTransport({"token": "MOCK-CHALLENGE", "so": {"required": True}}, sdk)
            with self.subTest(sdk=sdk), self.assertRaises(s.SentinelError):
                s.get_tokens(transport, "mock-device", "authorize_continue")

    def test_vm_escape_does_not_grant_fs_child_worker_or_network(self):
        # Intentionally escape vm: it is NOT the security boundary. Probe actual
        # Node/OS restrictions, including real socket creation on loopback only.
        # A same-group kill(0, 0) can succeed for the caller itself on macOS;
        # use a separate group to test whether another process is reachable.
        sleeper = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], start_new_session=True)
        def cleanup():
            sleeper.kill()
            sleeper.wait()
        self.addCleanup(cleanup)
        sdk = r"""
        var SentinelSDK={init:async()=>{
          const p=console.log.constructor('return process')();
          const req=p.getBuiltinModule.bind(p);
          const results={env:Object.keys(p.env)};
          for(const [name,fn] of Object.entries({
            read:()=>req('fs').readFileSync('/etc/hosts'),
            write:()=>req('fs').writeFileSync('/dev/null','mock'),
            child:()=>req('child_process').spawnSync(p.execPath,['--version']),
            worker:()=>new (req('worker_threads').Worker)('1',{eval:true}),
            signalParent:()=>p.kill(p.ppid,0),
            signalGroup:()=>p.kill(-__OUTSIDE_PID__,0),
          })) {
            try{fn();results[name]='ALLOWED';}catch(e){results[name]=e.code;}
          }
          results.network=await new Promise(resolve=>{
            const server=req('net').createServer();
            server.on('error',e=>resolve(e.code));
            server.listen(0,'127.0.0.1',()=>{server.close();resolve('ALLOWED');});
          });
          document.createElement('iframe').contentWindow.postMessage(
            {p:JSON.stringify(results),requestId:'probe'},'https://sentinel.openai.com');
        }};
        """
        result = json.loads(self.action(sdk.replace("__OUTSIDE_PID__", str(sleeper.pid)))["request_p"])
        self.assertEqual(result["env"], ["PATH"])
        for key in ("read", "write", "child", "worker"):
            self.assertEqual(result[key], "ERR_ACCESS_DENIED", (key, result))
        self.assertIn(result["network"], {"EPERM", "EACCES"})
        for key in ("signalParent", "signalGroup"):
            self.assertIn(result[key], {"EPERM", "EACCES"}, (key, result))

    def test_fetch_is_not_network_adapter(self):
        sdk = "var SentinelSDK={init:async()=>{await fetch('https://example.invalid/');}};"
        with self.assertRaises(s.SentinelError):
            self.action(sdk)

    def test_node_stays_in_parent_cancellation_group(self):
        actual = subprocess.Popen
        groups = []
        def capture(*args, **kwargs):
            proc = actual(*args, **kwargs)
            groups.append((kwargs["start_new_session"], os.getpgid(proc.pid)))
            return proc
        with patch.object(s.subprocess, "Popen", side_effect=capture):
            self.action(MOCK_SDK)
        self.assertEqual(groups, [(False, os.getpgrp())])

    def test_real_sync_and_async_timeouts_reaped(self):
        actual = subprocess.Popen
        processes = []
        def capture(*args, **kwargs):
            proc = actual(*args, **kwargs)
            processes.append(proc)
            return proc
        for sdk in ("while(true){}", "var SentinelSDK={init:()=>new Promise(()=>{})};"):
            started = time.monotonic()
            with self.subTest(sdk=sdk), patch.object(s.subprocess, "Popen", side_effect=capture):
                with self.assertRaises(s.SentinelError):
                    self.action(sdk, timeout=0.25)
            self.assertLess(time.monotonic() - started, 2)
            self.assertIsNotNone(processes[-1].poll())
            self.assertTrue(all(stream.closed for stream in
                                (processes[-1].stdin, processes[-1].stdout, processes[-1].stderr)))

    def test_real_stdout_and_stderr_caps(self):
        actual = subprocess.Popen
        processes = []
        def capture(*args, **kwargs):
            proc = actual(*args, **kwargs)
            processes.append(proc)
            return proc
        for name in ("stdout", "stderr"):
            sdk = f"var SentinelSDK={{init:()=>new Promise(()=>{{console.log.constructor('return process')().{name}.write('MOCK-SECRET'.repeat(20000));}})}};"
            with self.subTest(stream=name), patch.object(s.subprocess, "Popen", side_effect=capture):
                with self.assertRaises(s.SentinelError) as caught:
                    self.action(sdk)
            self.assertIn("output limit", str(caught.exception))
            self.assertNotIn("MOCK-SECRET", str(caught.exception))
            self.assertIsNotNone(processes[-1].poll())

    def test_sdk_only_stdin_and_memory(self):
        actual = subprocess.Popen
        seen = []
        def capture(*args, **kwargs):
            seen.append(args[0])
            return actual(*args, **kwargs)
        files_before = set(s._VENDOR.iterdir())
        with patch.object(s.subprocess, "Popen", side_effect=capture):
            self.assertEqual(self.action(MOCK_SDK), {"request_p": "MOCK-PROOF"})
        self.assertEqual(set(s._VENDOR.iterdir()), files_before)
        self.assertNotIn("MOCK-PROOF", " ".join(seen[0]))
        self.assertNotIn("OPENAI_SENTINEL_SDK_FILE", " ".join(seen[0]))


if __name__ == "__main__":
    unittest.main()
