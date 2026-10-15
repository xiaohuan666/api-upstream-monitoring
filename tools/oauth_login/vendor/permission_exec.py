"""OS network restriction installed before exec; no SDK or secrets here.

Node 22/24 permissions do not restrict networking. Deny socket creation (also
socketpair/io_uring), tracing/signalling other processes, and alternate ABIs
at OS level. Signal restrictions are kernel-enforced even after a vm escape.
Fail closed on unknown architectures or a kernel that refuses seccomp. This is
not a complete adversarial-code sandbox and does not claim to be one.
"""
import ctypes
import errno
import os
import platform
import resource
import sys


def main():
    # Prevent SDK/challenge memory from reaching core dumps and regular-file
    # contents even on a native crash. Pipes used for IPC are unaffected.
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    if sys.platform == "darwin":
        sandbox = "/usr/bin/sandbox-exec"
        os.execv(sandbox, [sandbox, "-p", "(version 1)(allow default)(deny network*)(deny signal)", *sys.argv[1:]])
    if sys.platform != "linux":
        raise RuntimeError("unsupported platform")
    machine = platform.machine()
    if machine == "x86_64":
        arch = 0xC000003E
        denied = [41, 53, 101, 310, 311, 425, 426, 427,
                  62, 200, 234, 129, 297, 424]
    elif machine in {"aarch64", "arm64"}:
        arch = 0xC00000B7
        denied = [198, 199, 117, 270, 271, 425, 426, 427,
                  129, 130, 131, 138, 240, 424]
    else:
        raise RuntimeError("unsupported architecture")

    # kill/tkill/tgkill/queued signals/pidfd_send_signal are denied as well as
    # networking: Node permissions alone do not stop process.kill(parent_pid).
    class Filter(ctypes.Structure):
        _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte),
                    ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint32)]

    class Program(ctypes.Structure):
        _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(Filter))]

    # Reject compatibility ABIs rather than matching only native syscall numbers.
    code = [(0x20, 0, 0, 4), (0x15, 1, 0, arch), (0x06, 0, 0, 0x80000000),
            (0x20, 0, 0, 0), (0x35, 0, 1, 0x40000000),
            (0x06, 0, 0, 0x00050000 | errno.EPERM)]
    for number in denied:
        code.extend([(0x15, 0, 1, number), (0x06, 0, 0, 0x00050000 | errno.EPERM)])
    code.append((0x06, 0, 0, 0x7FFF0000))
    filters = (Filter * len(code))(*(Filter(*item) for item in code))
    program = Program(len(code), filters)
    libc = ctypes.CDLL(None, use_errno=True)
    # no_new_privs is inherited across exec and prevents privileged escape.
    if libc.prctl(38, 1, 0, 0, 0) or libc.prctl(22, 2, ctypes.byref(program), 0, 0):
        raise RuntimeError("isolation unavailable")
    os.execv(sys.argv[1], sys.argv[1:])


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # No raw OS exception/argv/environment in diagnostic output.
        sys.stderr.write("Sentinel isolation unavailable\n")
        sys.exit(1)
