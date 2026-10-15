"""Bounded Sentinel support; no registration framework, SDK cache or login I/O.

Public contract: get_tokens(transport, device_id, flow) -> (token, so_token).
The caller owns the TLS profile/proxy/cookies and maps SentinelError to
OAUTH_SENTINEL_FAILED. Node's vm is a browser compatibility context, not a
security sandbox. Only this module's fixed URLs are requested through transport.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import re
import selectors
import shutil
import subprocess
import sys
import time
from typing import Any

from .errors import LoginError
from .transport import check_response

SENTINEL_VERSION = "20260219f9f6"
SDK_URL = f"https://sentinel.openai.com/sentinel/{SENTINEL_VERSION}/sdk.js"
REQ_URL = "https://sentinel.openai.com/backend-api/sentinel/req"
_VENDOR = Path(__file__).resolve().parent / "vendor"
_RUNNER = _VENDOR / "sentinel_runner.cjs"
_OS_LAUNCHER = _VENDOR / "permission_exec.py"
TOTAL_TIMEOUT = 60.0
NODE_TIMEOUT = 20.0
HTTP_TIMEOUT = 10.0
MAX_SDK_BYTES = 2 * 1024 * 1024
MAX_CHALLENGE_BYTES = 256 * 1024
MAX_INPUT_BYTES = MAX_SDK_BYTES + MAX_CHALLENGE_BYTES + 256 * 1024
MAX_STDOUT_BYTES = 128 * 1024
MAX_STDERR_BYTES = 16 * 1024
MAX_TOKEN_BYTES = 64 * 1024


class SentinelError(RuntimeError):
    """Local fail-closed error with a static, credential-free diagnostic."""


def _remaining(deadline: float, maximum: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise SentinelError("Sentinel deadline exceeded")
    return min(remaining, maximum)


def _encoded(value: Any, limit: int) -> bytes:
    try:
        data = json.dumps(value, ensure_ascii=False, separators=(",", ":"),
                          allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeError, RecursionError):
        raise SentinelError("Sentinel invalid JSON") from None
    if len(data) > limit:
        raise SentinelError("Sentinel input limit exceeded")
    return data


def _string(value: Any, limit: int, *, empty: bool = False) -> str:
    if not isinstance(value, str) or (not empty and not value.strip()):
        raise SentinelError("Sentinel missing or invalid string")
    try:
        size = len(value.encode("utf-8"))
    except UnicodeError:
        raise SentinelError("Sentinel invalid string encoding") from None
    if size > limit or any(c in value for c in "\r\n\x00"):
        raise SentinelError("Sentinel string limit exceeded")
    return value


def _isolated_command(node: str, arguments: list[str]) -> list[str]:
    # No wildcard fs grants, fs writes, child_process, worker, addon or WASI grants.
    command = [node, "--permission", f"--allow-fs-read={_RUNNER}",
               "--max-old-space-size=128", "--stack-size=1024", *arguments]
    # A trusted launcher also disables core dumps: SDK memory must not become
    # a crash artifact. It never reads stdin; exec leaves those bytes for Node.
    if sys.platform == "linux" or (sys.platform == "darwin" and
                                    Path("/usr/bin/sandbox-exec").is_file()):
        return [sys.executable, "-I", "-B", str(_OS_LAUNCHER), *command]
    raise SentinelError("Sentinel OS isolation unavailable")


def _run_process(command: list[str], data: bytes, timeout: float,
                 *, stdout_limit: int = MAX_STDOUT_BYTES) -> bytes:
    """Stream all pipes with hard byte/deadline limits, kill and reap on failure.

    communicate(capture_output) is intentionally avoided: a hostile SDK can
    otherwise allocate unbounded parent memory before communicate returns.
    stderr is counted then discarded, never returned, logged or used in errors.
    """
    env = {"PATH": os.environ.get("PATH", os.defpath)}
    deadline = time.monotonic() + timeout
    proc = None
    output = bytearray()
    counts = {"stdout": 0, "stderr": 0}
    offset = 0
    try:
        proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, env=env, cwd=str(_VENDOR),
                                close_fds=True, start_new_session=False)
        with selectors.DefaultSelector() as selector:
            for stream, name, events in ((proc.stdin, "stdin", selectors.EVENT_WRITE),
                                        (proc.stdout, "stdout", selectors.EVENT_READ),
                                        (proc.stderr, "stderr", selectors.EVENT_READ)):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, events, name)
            while selector.get_map():
                remaining = _remaining(deadline, 0.1)
                for key, _ in selector.select(remaining):
                    stream, name = key.fileobj, key.data
                    if name == "stdin":
                        try:
                            written = os.write(stream.fileno(), data[offset:offset + 65536])
                            offset += written
                        except BrokenPipeError:
                            offset = len(data)
                        except BlockingIOError:
                            continue
                        if offset == len(data):
                            selector.unregister(stream)
                            stream.close()
                        continue
                    try:
                        chunk = os.read(stream.fileno(), 65536)
                    except BlockingIOError:
                        continue
                    if not chunk:
                        selector.unregister(stream)
                        stream.close()
                        continue
                    counts[name] += len(chunk)
                    limit = stdout_limit if name == "stdout" else MAX_STDERR_BYTES
                    if counts[name] > limit:
                        raise SentinelError("Sentinel subprocess output limit exceeded")
                    if name == "stdout":
                        output.extend(chunk)
        proc.wait(timeout=_remaining(deadline, timeout))
        if proc.returncode != 0:
            raise SentinelError("Sentinel subprocess failed")
        return bytes(output)
    except SentinelError:
        raise
    except subprocess.TimeoutExpired:
        raise SentinelError("Sentinel subprocess timed out") from None
    except (OSError, ValueError):
        raise SentinelError("Sentinel subprocess unavailable") from None
    finally:
        if proc is not None:
            # Launcher execs in place and Node cannot spawn descendants. Keep
            # this child in the worker group so the parent's group cancellation
            # also reaches it; creating a new session would orphan it on abort.
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            proc.wait()
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                if stream is not None and not stream.closed:
                    stream.close()


def _node_binary(deadline: float) -> str:
    node = shutil.which("node", path=os.environ.get("PATH", os.defpath))
    if not node:
        raise SentinelError("Sentinel Node runtime unavailable")
    node = str(Path(node).resolve())
    version = _run_process(_isolated_command(node, ["--version"]), b"",
                           _remaining(deadline, 3.0), stdout_limit=64)
    match = re.fullmatch(rb"v(\d+)\.\d+\.\d+\s*", version)
    if not match or int(match.group(1)) < 22:
        raise SentinelError("Sentinel requires Node >=22 with --permission")
    return node


def _run_action(node: str, action: str, sdk: str, payload: dict,
                deadline: float) -> dict:
    body = {**payload, "action": action, "sdk": sdk}
    data = _encoded(body, MAX_INPUT_BYTES)
    output = _run_process(_isolated_command(node, [str(_RUNNER)]), data,
                          _remaining(deadline, NODE_TIMEOUT))
    try:
        result = json.loads(output)
    except (ValueError, UnicodeError, RecursionError):
        raise SentinelError("Sentinel invalid runner response") from None
    expected = {"request_p"} if action == "requirements" else {"token", "so_token"}
    if not isinstance(result, dict) or set(result) != expected:
        raise SentinelError("Sentinel invalid runner protocol")
    return result


def _fingerprint_payload(fingerprint: Any) -> dict:
    """Select only browser fields, never forward transport/proxy/account metadata."""
    if not isinstance(fingerprint, dict):
        raise SentinelError("Sentinel fingerprint unavailable")
    result = {}
    strings = {"user_agent": ("user_agent", "Mozilla/5.0"),
               "platform": ("navigator_platform", fingerprint.get("platform", "Win32")),
               "vendor": ("navigator_vendor", fingerprint.get("vendor", "Google Inc.")),
               "language": ("lang", "en-US"), "timezone": ("timezone", "UTC")}
    for target, (source, default) in strings.items():
        result[target] = _string(fingerprint.get(source, default), 2048, empty=target == "vendor")
    language_header = _string(fingerprint.get("lang_full", result["language"]), 2048)
    result["languages"] = [part.split(";", 1)[0].strip()
                           for part in language_header.split(",") if part.strip()][:16]
    screen = _string(fingerprint.get("screen", "1920x1080"), 32)
    match = re.fullmatch(r"([1-9]\d{0,4})x([1-9]\d{0,4})", screen)
    if not match:
        raise SentinelError("Sentinel invalid screen fingerprint")
    result["screen_width"], result["screen_height"] = map(int, match.groups())
    numbers = {"hardware_concurrency": (8, 1, 256), "max_touch_points": (0, 0, 64),
               "device_pixel_ratio": (1.0, 0.1, 10)}
    if fingerprint.get("device_memory") is not None:
        numbers["device_memory"] = (8, 0.1, 1024)
    for name, (default, low, high) in numbers.items():
        value = fingerprint.get(name, default)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
            raise SentinelError("Sentinel invalid numeric fingerprint")
        result[name] = value
    return result


def _request(transport: Any, method: str, url: str, deadline: float, **kwargs: Any) -> Any:
    if (method, url) not in {("GET", SDK_URL), ("POST", REQ_URL)}:
        raise SentinelError("Sentinel untrusted request")
    # A task owns this transport exclusively. Temporarily tighten its existing
    # deadline rather than bypassing its private timeout/redirect/proxy policy.
    previous_deadline = getattr(transport, "deadline", None)
    if previous_deadline is not None:
        transport.deadline = min(previous_deadline, time.monotonic() +
                                 _remaining(deadline, HTTP_TIMEOUT))
    try:
        response = transport.request(method, url, **kwargs)
    finally:
        if previous_deadline is not None:
            transport.deadline = previous_deadline
    check_response(response)
    _remaining(deadline, TOTAL_TIMEOUT)
    if getattr(response, "status_code", None) != 200:
        raise SentinelError("Sentinel HTTP rejected")
    # Defensive check if a non-conforming transport silently follows redirects.
    final_url = getattr(response, "url", url)
    if final_url != url:
        raise SentinelError("Sentinel unexpected response URL")
    return response


def get_tokens(transport: Any, device_id: str, flow: str) -> tuple[str, str]:
    """Get SDK-produced tokens or fail; no retries, network fallback or success claim.

    transport.request(method, url, **kwargs) must apply HTTP time/body limits and
    TLS/profile/proxy/cookie policy. Each task exclusively owns its transport;
    its mutable monotonic deadline is temporarily tightened for each HTTP call.
    Python owns the only two HTTP calls. The
    optional SO token is required iff challenge.so.required is exactly True.
    """
    deadline = time.monotonic() + TOTAL_TIMEOUT
    try:
        transport_deadline = getattr(transport, "deadline", deadline)
        if not isinstance(transport_deadline, (int, float)) or not math.isfinite(transport_deadline):
            raise SentinelError("Sentinel invalid transport deadline")
        deadline = min(deadline, transport_deadline)
        device_id = _string(device_id, 256)
        flow = _string(flow, 128)
        if not re.fullmatch(r"[A-Za-z0-9_-]+", flow):
            raise SentinelError("Sentinel invalid flow")
        payload = _fingerprint_payload(transport.fingerprint)
        payload.update(device_id=device_id, flow=flow)
        # Validate runtime/isolation before making even the SDK network request.
        node = _node_binary(deadline)
        headers = {"accept": "*/*", "User-Agent": payload["user_agent"],
                   "Accept-Language": transport.fingerprint.get("lang_full", payload["language"]),
                   "referer": "https://auth.openai.com/", "sec-fetch-dest": "script",
                   "sec-fetch-mode": "no-cors", "sec-fetch-site": "same-site"}
        sdk_response = _request(transport, "GET", SDK_URL, deadline, headers=headers)
        sdk = sdk_response.text
        if not isinstance(sdk, str) or not sdk.strip() or len(sdk.encode("utf-8")) > MAX_SDK_BYTES:
            raise SentinelError("Sentinel SDK body limit exceeded")
        requirements = _run_action(node, "requirements", sdk, payload, deadline)
        request_p = _string(requirements.get("request_p"), MAX_TOKEN_BYTES)
        headers = {**headers, "origin": "https://sentinel.openai.com",
                   "referer": f"https://sentinel.openai.com/backend-api/sentinel/frame.html?sv={SENTINEL_VERSION}",
                   "content-type": "text/plain;charset=UTF-8", "sec-fetch-dest": "empty",
                   "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin"}
        response = _request(transport, "POST", REQ_URL, deadline, headers=headers,
                            data=_encoded({"p": request_p, "id": device_id, "flow": flow},
                                          MAX_CHALLENGE_BYTES).decode("utf-8"))
        if not isinstance(response.text, str) or len(response.text.encode("utf-8")) > MAX_CHALLENGE_BYTES:
            raise SentinelError("Sentinel challenge body limit exceeded")
        challenge = response.json()
        if not isinstance(challenge, dict):
            raise SentinelError("Sentinel invalid challenge")
        _encoded(challenge, MAX_CHALLENGE_BYTES)
        _string(challenge.get("token"), MAX_TOKEN_BYTES)
        so = challenge.get("so")
        if so is not None and (not isinstance(so, dict) or
                               ("required" in so and type(so["required"]) is not bool)):
            raise SentinelError("Sentinel invalid observer challenge")
        solved = _run_action(node, "solve", sdk,
                             {**payload, "request_p": request_p, "challenge": challenge}, deadline)
        token = _string(solved.get("token"), MAX_TOKEN_BYTES)
        so_token = _string(solved.get("so_token"), MAX_TOKEN_BYTES, empty=True)
        if isinstance(so, dict) and so.get("required") is True:
            _string(so_token, MAX_TOKEN_BYTES)
        else:
            # Never carry an observer token from another flow where it is not needed.
            so_token = ""
        return token, so_token
    except SentinelError:
        raise
    except LoginError as error:
        if error.code in {"OAUTH_HTTP_CHALLENGE", "OAUTH_VERIFICATION_REQUIRED"}:
            raise
        raise SentinelError("Sentinel transport failed") from None
    except Exception:
        # Transport/SDK exceptions may embed URLs, proxy passwords or tokens.
        raise SentinelError("Sentinel operation failed") from None
