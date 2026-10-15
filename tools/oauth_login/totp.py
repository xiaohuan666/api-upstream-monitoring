"""RFC6238 logic adapted from any-auto-register@44c27a8 protocol/totp.py."""
import base64
import hashlib
import hmac
import re
import struct
import time

from .errors import LoginError


def normalize_secret(secret):
    if not isinstance(secret, str) or len(secret) > 4096:
        raise LoginError("OAUTH_INVALID_TOTP_SECRET")
    raw = re.sub(r"\s", "", secret).upper()
    value = raw.rstrip("=")
    try:
        if not re.fullmatch(r"[A-Z2-7]+", value) or (raw != value and len(raw) - len(value) != (-len(value) % 8)):
            raise ValueError()
        key = base64.b32decode(value + "=" * (-len(value) % 8))
        if base64.b32encode(key).decode().rstrip("=") != value:
            raise ValueError()
    except ValueError:
        raise LoginError("OAUTH_INVALID_TOTP_SECRET") from None
    return value


def totp_now(secret, at=None):
    value = normalize_secret(secret)
    key = base64.b32decode(value + "=" * (-len(value) % 8))
    digest = hmac.new(key, struct.pack(">Q", int(time.time() if at is None else at) // 30), hashlib.sha1).digest()
    offset = digest[-1] & 15
    return str((struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7fffffff) % 1000000).zfill(6)
