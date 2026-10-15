"""stdin secrets -> bounded NDJSON events; no credential files or traceback output."""
import json
import logging
import resource
import sys
from pathlib import Path

# This file is launched by absolute path, not through a shell or package installer.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from oauth_login.errors import LoginError
from oauth_login.flow import LoginFlow, validate_input
from oauth_login.transport import Transport


def emit(event):
    sys.stdout.write(json.dumps(event, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    if event.get("type") == "stage":
        # A stage is persisted by Node before any associated external request.
        # EOF/malformed ACK means the lease/store/caller is no longer available.
        try:
            ack = json.loads(sys.stdin.buffer.readline(257))
        except (ValueError, UnicodeError):
            raise LoginError("OAUTH_ABORTED") from None
        if ack != {"type": "ack", "stage": event["stage"]}:
            raise LoginError("OAUTH_ABORTED")


def main():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    logging.disable(logging.CRITICAL)
    transport = None
    data = None
    try:
        raw = sys.stdin.buffer.readline(65537)
        if len(raw) > 65536:
            raise LoginError("OAUTH_INVALID_INPUT")
        data = validate_input(json.loads(raw))
        from oauth_login.sentinel import get_tokens
        transport = Transport(data.get("proxy"), data.get("timeoutMs", 120000))
        result = LoginFlow(transport, get_tokens, emit).run(data)
        emit({"type": "result", **result})
        return 0
    except (ImportError, ModuleNotFoundError):
        emit({"type": "error", "code": "OAUTH_WORKER_UNAVAILABLE"})
    except LoginError as exc:
        emit(exc.worker_event())
    except Exception:
        emit({"type": "error", "code": "OAUTH_LOGIN_FAILED"})
    finally:
        if data is not None and isinstance(data, dict):
            data.clear()
        if transport is not None:
            try:
                transport.close()
            except Exception:
                pass
    return 1


if __name__ == "__main__":
    sys.exit(main())
