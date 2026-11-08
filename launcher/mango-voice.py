#!/usr/bin/env python3
# mango-voice.py - local voice transcription for mango-code: space key hook and web service.
#
# In the Mango Code terminal hold the SPACE BAR: the key is swallowed, you start listening and
# the text is typed while you speak. On release it stops. A quick tap of space stays a normal
# space. In other windows space is not touched: the hook acts only if the Mango Code console is
# in the foreground (see MangoWindow).
# With --serve, instead, no hook: an HTTP service on 127.0.0.1 transcribes the audio that the
# web UI records with the microphone button (it reaches it from the opencode server, see cmd_serve).
# All local, on CPU (faster-whisper).
#
#   python mango-voice.py              # starts the space key hook (in the background)
#   python mango-voice.py --off        # stops the listening instance
#   python mango-voice.py --serve      # transcription service for the web UI (port 4097)
#   python mango-voice.py --devices
#   python mango-voice.py --test 3
#   python mango-voice.py --audio file.wav
#
# Config next to the script: mango-voice.json (see mango-voice.example.json).

import argparse
import ctypes
import io
import json
import os
import sys
import threading
import time
import wave
from pathlib import Path

import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
RUNTIME = SCRIPT_DIR / "runtime"
CONFIG_PATH = SCRIPT_DIR / "mango-voice.json"
EXAMPLE_PATH = SCRIPT_DIR / "mango-voice.example.json"

# The sample rate is fixed at 16 kHz mono: it is exactly what Whisper expects, and using the
# device default (44.1/48 kHz) would force a useless resample.
SAMPLE_RATE = 16000

DEFAULTS = {
    "model": "small",
    "language": "it",
    "device": None,          # NULL = system default microphone; otherwise index or name
    "compute_type": "int8",
    "tap_hold_ms": 300,      # below this threshold space is a normal tap, above it we listen
    "poll_ms": 400,          # how often the worker transcribes the accumulated window
    "finalize_lag_ms": 700,  # a segment is "done" only if followed by this much silence
    "min_audio_ms": 400,     # below this amount of audio we do not transcribe
    "max_window_s": 20,      # if the window grows beyond this, finalize without waiting for silence
}

EXAMPLE = {
    "_note": (
        "Config of mango-voice.py. Copy this file to mango-voice.json and edit the values. "
        "model: faster-whisper model name (tiny/base/small/medium/large-v3). "
        "language: ISO-639-1 language code passed to Whisper. "
        "device: input microphone (index as in --devices, or name). null = system default. "
        "compute_type: CPU quantization (int8 recommended on CPU without GPU). "
        "tap_hold_ms: tap/hold threshold of the space bar in milliseconds. "
        "poll_ms: how often, in ms, the worker transcribes the accumulated window. "
        "finalize_lag_ms: a segment is typed only if followed by this much silence. "
        "min_audio_ms: minimum amount of audio to transcribe. "
        "max_window_s: beyond this duration the window is forced to close."
    ),
    "model": "small",
    "language": "it",
    "device": None,
    "compute_type": "int8",
    "tap_hold_ms": 300,
    "poll_ms": 400,
    "finalize_lag_ms": 700,
    "min_audio_ms": 400,
    "max_window_s": 20,
}

_MODEL = None
_MODEL_KEY = None


# The language of the user-facing texts: "language" in <data>\settings.json ("it" or "en", shared with
# the app and the terminal), otherwise the Windows display language (Italian if Windows is Italian,
# English otherwise). Re-read at every call.
def lang() -> str:
    data_dir = os.environ.get("MANGO_DATA") or os.path.join(os.environ.get("LOCALAPPDATA", ""), "MangoCode")
    try:
        chosen = json.loads(Path(data_dir, "settings.json").read_text(encoding="utf-8-sig")).get("language")
        if chosen in ("it", "en"):
            return chosen
    except (OSError, ValueError, AttributeError):
        pass
    if os.name == "nt" and ctypes.windll.kernel32.GetUserDefaultUILanguage() & 0x3FF == 0x10:
        return "it"
    return "en"


def tr(it: str, en: str) -> str:
    return it if lang() == "it" else en


# --------------------------------------------------------------------------------------------
# Space key hook: Win32 constants and structures.
# The structures use portable ctypes types (c_uint32/c_size_t/...) instead of ctypes.wintypes:
# this way the module also imports outside Windows, where only --listen/--off fail.
# --------------------------------------------------------------------------------------------
WH_KEYBOARD_LL = 13
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
WM_SYSKEYDOWN = 0x0104
WM_SYSKEYUP = 0x0105
WM_QUIT = 0x0012
PM_REMOVE = 0x0001
VK_SPACE = 0x20
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
MAPVK_VK_TO_VSC = 0
EVENT_MODIFY_STATE = 0x0002
ERROR_ALREADY_EXISTS = 183
INFINITE = 0xFFFFFFFF
SYNCHRONIZE = 0x00100000
GA_ROOTOWNER = 3

# The Mango Code console is recognized this way (see MangoWindow): the launcher gives it this
# title and turns off the title the agent would write over it.
MANGO_TITLE = "Mango Code"
WINDOWS_TERMINAL_CLASS = "CASCADIA_HOSTING_WINDOW_CLASS"

# Fixed port of the transcription service (--serve): 4096 is the web server's, 4090-4095 the team's.
SERVE_PORT = 4097
# Cap on the audio of one request: 10 minutes of opus from MediaRecorder are ~2-3 MB.
MAX_AUDIO_BYTES = 25 * 1024 * 1024

# Signature of the events we inject: the hook recognizes them by dwExtraInfo and lets them pass.
# Without this mark the typed text would re-enter the hook, which would re-enter the text.
VOICE_SIGNATURE = 0x4D414E47  # "MANG"

MUTEX_NAME = "mango-voice-singleton-v1"
EVENT_NAME = "mango-voice-stop-v1"

_SINGLETON = None  # mutex handle, kept alive for the whole life of the process


class KBDLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [
        ("vkCode", ctypes.c_uint32),
        ("scanCode", ctypes.c_uint32),
        ("flags", ctypes.c_uint32),
        ("time", ctypes.c_uint32),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", ctypes.c_uint16),
        ("wScan", ctypes.c_uint16),
        ("dwFlags", ctypes.c_uint32),
        ("time", ctypes.c_uint32),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", ctypes.c_int32),
        ("dy", ctypes.c_int32),
        ("mouseData", ctypes.c_uint32),
        ("dwFlags", ctypes.c_uint32),
        ("time", ctypes.c_uint32),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", ctypes.c_uint32),
        ("wParamL", ctypes.c_uint16),
        ("wParamH", ctypes.c_uint16),
    ]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", ctypes.c_uint32), ("u", _INPUTUNION)]


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_int32), ("y", ctypes.c_int32)]


class MSG(ctypes.Structure):
    _fields_ = [
        ("hwnd", ctypes.c_void_p),
        ("message", ctypes.c_uint32),
        ("wParam", ctypes.c_size_t),
        ("lParam", ctypes.c_ssize_t),
        ("time", ctypes.c_uint32),
        ("pt", POINT),
    ]


def fail(msg: str, code: int = 2):
    """Operational error, not a bug: message in the user's language and non-zero exit, no traceback."""
    print(f"{tr('ERRORE', 'ERROR')}: {msg}", file=sys.stderr)
    sys.exit(code)


def _validate_config(cfg: dict) -> dict:
    """Normalizes and checks the config; raises ValueError with a clear message if it is inconsistent."""
    def integer(key, minimum):
        try:
            v = int(cfg[key])
        except (KeyError, TypeError, ValueError):
            raise ValueError(tr(f"{key} deve essere un intero", f"{key} must be an integer"))
        if v < minimum:
            raise ValueError(tr(f"{key} deve essere >= {minimum}", f"{key} must be >= {minimum}"))
        return v

    cfg["tap_hold_ms"] = integer("tap_hold_ms", 30)
    cfg["poll_ms"] = integer("poll_ms", 100)
    cfg["finalize_lag_ms"] = integer("finalize_lag_ms", 100)
    cfg["min_audio_ms"] = integer("min_audio_ms", 100)
    try:
        cfg["max_window_s"] = float(cfg["max_window_s"])
    except (KeyError, TypeError, ValueError):
        raise ValueError(tr("max_window_s deve essere un numero", "max_window_s must be a number"))
    if cfg["max_window_s"] < 2:
        raise ValueError(tr("max_window_s deve essere >= 2", "max_window_s must be >= 2"))

    for key in ("model", "language", "compute_type"):
        if not isinstance(cfg.get(key), str) or not cfg[key].strip():
            raise ValueError(tr(f"{key} deve essere una stringa non vuota", f"{key} must be a non-empty string"))
        cfg[key] = cfg[key].strip()
    return cfg


def load_config() -> dict:
    cfg = dict(DEFAULTS)
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError) as e:
            fail(tr(f"config illeggibile ({CONFIG_PATH}): {e}", f"unreadable config ({CONFIG_PATH}): {e}"))
    try:
        return _validate_config(cfg)
    except ValueError as e:
        fail(tr(f"config non valida ({CONFIG_PATH}): {e}", f"invalid config ({CONFIG_PATH}): {e}"))


def get_model(cfg: dict):
    """Loads the model once per process and reuses it."""
    global _MODEL, _MODEL_KEY
    key = (cfg["model"], cfg["compute_type"])
    if _MODEL is None or _MODEL_KEY != key:
        from faster_whisper import WhisperModel

        print(f"[voice] loading model '{cfg['model']}' (cpu/{cfg['compute_type']})...", file=sys.stderr)
        _MODEL = WhisperModel(cfg["model"], device="cpu", compute_type=cfg["compute_type"])
        _MODEL_KEY = key
    return _MODEL


def device_label(device) -> str:
    """Readable name of the device, for the final report."""
    import sounddevice as sd

    try:
        info = sd.query_devices(device, "input") if device is not None else sd.query_devices(kind="input")
        return info["name"]
    except Exception:
        return tr("sconosciuto", "unknown")


# --------------------------------------------------------------------------------------------
# Key injection (SendInput), always marked with the signature.
# --------------------------------------------------------------------------------------------
def _send_inputs(inputs):
    if len(inputs) == 0:
        return
    sent = _user32().SendInput(len(inputs), inputs, ctypes.sizeof(INPUT))
    if sent != len(inputs):
        print("[voice] SendInput rejected part of the events", file=sys.stderr)


def send_vk(vk: int):
    """Press+release a virtual key, signed: it is the forwarded space tap."""
    scan = _user32().MapVirtualKeyW(vk, MAPVK_VK_TO_VSC)
    arr = (INPUT * 2)()
    arr[0].type = INPUT_KEYBOARD
    arr[0].u.ki = KEYBDINPUT(vk, scan, 0, 0, VOICE_SIGNATURE)
    arr[1].type = INPUT_KEYBOARD
    arr[1].u.ki = KEYBDINPUT(vk, scan, KEYEVENTF_KEYUP, 0, VOICE_SIGNATURE)
    _send_inputs(arr)


def send_unicode_text(text: str):
    """Types the text with KEYEVENTF_UNICODE, each event signed (anti-bounce)."""
    units = []
    for ch in text:
        for i in range(0, len(ch.encode("utf-16-le")), 2):
            units.append(int.from_bytes(ch.encode("utf-16-le")[i:i + 2], "little"))
    if not units:
        return
    arr = (INPUT * (len(units) * 2))()
    j = 0
    for u in units:
        arr[j].type = INPUT_KEYBOARD
        arr[j].u.ki = KEYBDINPUT(0, u, KEYEVENTF_UNICODE, 0, VOICE_SIGNATURE)
        j += 1
        arr[j].type = INPUT_KEYBOARD
        arr[j].u.ki = KEYBDINPUT(0, u, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0, VOICE_SIGNATURE)
        j += 1
    _send_inputs(arr)


# --------------------------------------------------------------------------------------------
# Win32 APIs loaded lazily, with explicit prototypes.
# --------------------------------------------------------------------------------------------
_API = {}


def _user32():
    if "user32" not in _API:
        if os.name != "nt":
            fail(tr("l'hook dello spazio e SendInput richiedono Windows", "the space hook and SendInput require Windows"))
        u = ctypes.WinDLL("user32", use_last_error=True)
        u.SendInput.argtypes = (ctypes.c_uint32, ctypes.POINTER(INPUT), ctypes.c_int)
        u.SendInput.restype = ctypes.c_uint32
        u.MapVirtualKeyW.argtypes = (ctypes.c_uint32, ctypes.c_uint32)
        u.MapVirtualKeyW.restype = ctypes.c_uint32
        u.SetWindowsHookExW.argtypes = (ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32)
        u.SetWindowsHookExW.restype = ctypes.c_void_p
        u.CallNextHookEx.argtypes = (ctypes.c_void_p, ctypes.c_int, ctypes.c_size_t, ctypes.c_ssize_t)
        u.CallNextHookEx.restype = ctypes.c_ssize_t
        u.UnhookWindowsHookEx.argtypes = (ctypes.c_void_p,)
        u.UnhookWindowsHookEx.restype = ctypes.c_int
        u.PeekMessageW.argtypes = (
            ctypes.POINTER(MSG), ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint32,
        )
        u.PeekMessageW.restype = ctypes.c_int
        u.TranslateMessage.argtypes = (ctypes.POINTER(MSG),)
        u.DispatchMessageW.argtypes = (ctypes.POINTER(MSG),)
        u.GetForegroundWindow.argtypes = ()
        u.GetForegroundWindow.restype = ctypes.c_void_p
        u.GetAncestor.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
        u.GetAncestor.restype = ctypes.c_void_p
        u.IsWindow.argtypes = (ctypes.c_void_p,)
        u.IsWindow.restype = ctypes.c_int
        u.GetClassNameW.argtypes = (ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int)
        u.GetClassNameW.restype = ctypes.c_int
        # InternalGetWindowText and not GetWindowTextW: it sends no messages to the window, so
        # inside the hook it cannot hang on a program that does not respond.
        u.InternalGetWindowText.argtypes = (ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int)
        u.InternalGetWindowText.restype = ctypes.c_int
        _API["user32"] = u
    return _API["user32"]


def _kernel32():
    if "kernel32" not in _API:
        if os.name != "nt":
            fail(tr("l'hook dello spazio richiede Windows", "the space hook requires Windows"))
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.GetModuleHandleW.argtypes = (ctypes.c_wchar_p,)
        k.GetModuleHandleW.restype = ctypes.c_void_p
        k.CreateMutexW.argtypes = (ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p)
        k.CreateMutexW.restype = ctypes.c_void_p
        k.CreateEventW.argtypes = (ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_wchar_p)
        k.CreateEventW.restype = ctypes.c_void_p
        k.OpenEventW.argtypes = (ctypes.c_uint32, ctypes.c_int, ctypes.c_wchar_p)
        k.OpenEventW.restype = ctypes.c_void_p
        k.SetEvent.argtypes = (ctypes.c_void_p,)
        k.SetEvent.restype = ctypes.c_int
        k.WaitForSingleObject.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
        k.WaitForSingleObject.restype = ctypes.c_uint32
        k.CloseHandle.argtypes = (ctypes.c_void_p,)
        k.CloseHandle.restype = ctypes.c_int
        k.GetConsoleWindow.argtypes = ()
        k.GetConsoleWindow.restype = ctypes.c_void_p
        k.SetConsoleTitleW.argtypes = (ctypes.c_wchar_p,)
        k.SetConsoleTitleW.restype = ctypes.c_int
        k.OpenProcess.argtypes = (ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32)
        k.OpenProcess.restype = ctypes.c_void_p
        _API["kernel32"] = k
    return _API["kernel32"]


# --------------------------------------------------------------------------------------------
# Which window is Mango Code: the hook acts only if its console is in the foreground.
# --------------------------------------------------------------------------------------------
def is_mango_window(foreground, console, console_root, window_class, title) -> bool:
    """Pure logic: is the foreground window the Mango Code console?

    conhost: the console IS the window (foreground == console), one session per window.
    Windows Terminal: the console is a hidden window (PseudoConsoleWindow) owned by the terminal
    window (console_root). That window, however, has several tabs, and its title is the active
    tab's: it must be the Mango Code title, so a neighbouring tab stays free.
    """
    if not foreground or not console:
        return False
    if foreground != console and foreground != console_root:
        return False
    if window_class == WINDOWS_TERMINAL_CLASS:
        return MANGO_TITLE in (title or "")
    return True


def _window_text(fn, hwnd) -> str:
    buf = ctypes.create_unicode_buffer(512)
    fn(hwnd, buf, len(buf))
    return buf.value


class MangoWindow:
    """The console of a Mango Code session, queried at every space press.

    The root is recomputed every time: Windows Terminal can move a tab to another window, and
    the console's owner changes with it.
    """

    def __init__(self, console_hwnd: int):
        self.console = console_hwnd

    def is_foreground(self) -> bool:
        u = _user32()
        foreground = u.GetForegroundWindow()
        if not foreground:
            return False
        root = u.GetAncestor(self.console, GA_ROOTOWNER)
        window_class = title = ""
        if foreground == self.console or foreground == root:
            window_class = _window_text(u.GetClassNameW, foreground)
            if window_class == WINDOWS_TERMINAL_CLASS:
                title = _window_text(u.InternalGetWindowText, foreground)
        return is_mango_window(foreground, self.console, root, window_class, title)


def watch_parent(pid: int, on_exit):
    """Calls on_exit() when the process pid ends (the session that launched us).

    Without it, closing the Mango Code window would leave the process alive, hidden, tied to a
    console that no longer exists and holding the mutex that stops the next session from starting.
    """
    kernel32 = _kernel32()
    handle = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
    if not handle:
        fail(tr(f"il processo {pid} (--parent) non esiste", f"process {pid} (--parent) does not exist"))

    def wait():
        kernel32.WaitForSingleObject(handle, INFINITE)
        kernel32.CloseHandle(handle)
        print(f"[voice] process {pid} has ended, exiting.", file=sys.stderr)
        on_exit()

    threading.Thread(target=wait, daemon=True).start()


def is_own_event(extra_info) -> bool:
    """True if the event was injected by us (dwExtraInfo signature): the hook must ignore it."""
    try:
        return int(extra_info) == VOICE_SIGNATURE
    except (TypeError, ValueError):
        return False


# --------------------------------------------------------------------------------------------
# Tap/hold state machine - pure logic, testable without Windows or a microphone.
# --------------------------------------------------------------------------------------------
class SpaceKeyHandler:
    """Decides whether a space bar event is suppressed and whether we start listening.

    press()/release() return True if the event is to be suppressed (the hook answers 1).
    If the key stays down past the threshold on_start() fires; on release, if the threshold did
    not fire, on_tap() fires (one normal space); if we were listening, on_stop().
    active() decides at the press whether space is ours: if not, that press (auto-repeat and
    release included) passes through intact, with no delay and without ever starting to listen.
    """

    IDLE, WAITING, LISTENING, PASSTHROUGH = range(4)

    def __init__(self, tap_hold_ms, on_start, on_stop, on_tap, schedule=None, active=None):
        self.tap_hold_s = max(int(tap_hold_ms), 1) / 1000.0
        self.on_start = on_start
        self.on_stop = on_stop
        self.on_tap = on_tap
        self._schedule = schedule or self._timer
        self._active = active or (lambda: True)
        self._lock = threading.Lock()
        self._state = self.IDLE
        self._cancel = None

    @staticmethod
    def _timer(delay, cb):
        t = threading.Timer(delay, cb)
        t.daemon = True
        t.start()
        return t.cancel

    def press(self) -> bool:
        """Key pressed. The original keydown is always suppressed: this machine decides."""
        with self._lock:
            if self._state == self.PASSTHROUGH:
                return False  # auto-repeat of a press that is not ours
            if self._state == self.IDLE:
                if not self._active():
                    self._state = self.PASSTHROUGH
                    return False
                self._state = self.WAITING
                self._cancel = self._schedule(self.tap_hold_s, self._expired)
            return True  # auto-repeats while WAITING/LISTENING are suppressed too

    def _expired(self):
        with self._lock:
            if self._state != self.WAITING:
                return
            self._state = self.LISTENING
            self._cancel = None
        self.on_start()

    def release(self) -> bool:
        with self._lock:
            state = self._state
            self._state = self.IDLE
            cancel = self._cancel
            self._cancel = None
        if state == self.PASSTHROUGH:
            return False
        if state == self.WAITING:
            if cancel:
                cancel()
            self.on_tap()
        elif state == self.LISTENING:
            self.on_stop()
        return True  # the keyup is ours too: we forward the tap ourselves with send_vk


# --------------------------------------------------------------------------------------------
# Listening session: accumulates the audio and types the finalized segments (VAD).
# --------------------------------------------------------------------------------------------
class ListenSession:
    """Keeps the microphone open between start() and stop(), transcribes by sentences and types."""

    def __init__(self, cfg, emit):
        self.cfg = cfg
        self.emit = emit
        self._lock = threading.Lock()
        self._chunks = []
        self._samples = 0
        self._stop = threading.Event()
        self._stream = None
        self._worker = None

    def start(self):
        import sounddevice as sd

        try:
            self._stream = sd.InputStream(
                samplerate=SAMPLE_RATE, channels=1, dtype="float32",
                device=self.cfg["device"], callback=self._on_audio, blocksize=0,
            )
            self._stream.start()
        except Exception as e:
            print(f"[voice] microphone unavailable: {e}", file=sys.stderr)
            self._stream = None
            self._stop.set()
            return
        self._worker = threading.Thread(target=self._work, daemon=True)
        self._worker.start()

    def _on_audio(self, indata, frames, time_info, status):
        # Sporadic overruns are not reported: the audio that arrives is enough, the rest is noise.
        with self._lock:
            self._chunks.append(indata[:, 0].copy())
            self._samples += frames

    def _window(self):
        with self._lock:
            if not self._chunks:
                return None
            return np.concatenate(self._chunks)

    def _discard(self, n_samples):
        with self._lock:
            while n_samples > 0 and self._chunks:
                first = self._chunks[0]
                if len(first) <= n_samples:
                    n_samples -= len(first)
                    self._chunks.pop(0)
                else:
                    self._chunks[0] = first[n_samples:]
                    n_samples = 0
            self._samples = sum(len(c) for c in self._chunks)

    def _transcribe_and_finalize(self, model, window, total_s, lag):
        """Transcribes the window and types the segments that have enough silence after them.

        Returns how many samples can be thrown away (up to the end of the last finished segment).
        """
        try:
            segments, _info = model.transcribe(
                window, language=self.cfg["language"], vad_filter=True,
                beam_size=1, condition_on_previous_text=False,
            )
            pieces = []
            consumed = 0
            for seg in segments:
                if seg.end <= total_s - lag:
                    text = seg.text.strip()
                    if text:
                        pieces.append(text)
                    consumed = int(round(seg.end * SAMPLE_RATE))
        except Exception as e:
            print(f"[voice] transcription failed: {e}", file=sys.stderr)
            return 0
        if pieces:
            self.emit(" ".join(pieces) + " ")
        return consumed

    def _work(self):
        # The model is loaded here: the audio is already buffered, so the start is not lost.
        model = get_model(self.cfg)
        poll_s = self.cfg["poll_ms"] / 1000.0
        min_samples = int(self.cfg["min_audio_ms"] * SAMPLE_RATE / 1000)
        lag = self.cfg["finalize_lag_ms"] / 1000.0
        max_win = self.cfg["max_window_s"]

        while True:
            done = self._stop.wait(poll_s)
            window = self._window()
            if window is None:
                if done:
                    break
                continue
            total_s = len(window) / SAMPLE_RATE
            if not done and len(window) < min_samples:
                continue
            # On release we do not wait for silence; if the window is too long the threshold is
            # relaxed, otherwise the transcription cost would grow without limit.
            if done:
                effective_lag = 0.0
            elif total_s > max_win:
                effective_lag = min(lag, 0.3)
            else:
                effective_lag = lag
            consumed = self._transcribe_and_finalize(model, window, total_s, effective_lag)
            if consumed:
                self._discard(consumed)
            if done:
                break

    def stop(self):
        self._stop.set()
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:
                pass
        if self._worker is not None:
            self._worker.join(timeout=30)


# --------------------------------------------------------------------------------------------
# Controller: connects the hook to the audio session and to the typing.
# --------------------------------------------------------------------------------------------
class VoiceController:
    def __init__(self, cfg, active):
        self.cfg = cfg
        self.handler = SpaceKeyHandler(cfg["tap_hold_ms"], self.start, self.stop, self.tap, active=active)
        self._lock = threading.Lock()
        self._session = None
        self._closing = None

    def tap(self):
        send_vk(VK_SPACE)

    def start(self):
        with self._lock:
            if self._session is not None:
                return
            closing = self._closing
        if closing is not None:
            closing.join(timeout=2.0)
        session = ListenSession(self.cfg, self._emit)
        with self._lock:
            self._session = session
        session.start()

    def stop(self):
        with self._lock:
            session = self._session
            self._session = None
        if session is None:
            return
        t = threading.Thread(target=session.stop, daemon=True)
        with self._lock:
            self._closing = t
        t.start()

    def _emit(self, text):
        if text:
            send_unicode_text(text)


class SpaceHook:
    """Installs the global low-level hook and pumps messages until it is stopped."""

    def __init__(self, handler):
        self.handler = handler
        self._hook = None
        self._proc = None
        self._stopped = threading.Event()
        self._warned = False

    def _process(self, ncode, wparam, lparam):
        user32 = _user32()
        if ncode < 0:
            return user32.CallNextHookEx(None, ncode, wparam, lparam)
        kb = ctypes.cast(lparam, ctypes.POINTER(KBDLLHOOKSTRUCT)).contents
        # Anti-bounce: events with our signature have already passed once too many.
        if is_own_event(kb.dwExtraInfo) or kb.vkCode != VK_SPACE:
            return user32.CallNextHookEx(None, ncode, wparam, lparam)
        # An exception in here would be swallowed by ctypes: we catch it and let the event
        # through, so a bug does not turn space into a key swallowed for nothing.
        try:
            msg = int(wparam)
            if msg in (WM_KEYDOWN, WM_SYSKEYDOWN):
                suppress = self.handler.press()
            elif msg in (WM_KEYUP, WM_SYSKEYUP):
                suppress = self.handler.release()
            else:
                suppress = False
        except Exception as e:
            if not self._warned:
                self._warned = True
                print(f"[voice] error in the hook, space passes through normally: {e}", file=sys.stderr)
            return user32.CallNextHookEx(None, ncode, wparam, lparam)
        if suppress:
            return 1
        return user32.CallNextHookEx(None, ncode, wparam, lparam)

    def install(self):
        user32, kernel32 = _user32(), _kernel32()
        HOOKPROC = ctypes.WINFUNCTYPE(
            ctypes.c_ssize_t, ctypes.c_int, ctypes.c_size_t, ctypes.c_ssize_t
        )
        self._proc = HOOKPROC(self._process)
        hmod = kernel32.GetModuleHandleW(None)
        ctypes.set_last_error(0)
        self._hook = user32.SetWindowsHookExW(WH_KEYBOARD_LL, self._proc, hmod, 0)
        if not self._hook:
            code = ctypes.get_last_error()
            fail(tr(f"impossibile installare l'hook della tastiera (codice {code})", f"cannot install the keyboard hook (code {code})"))

    def pump(self):
        msg = MSG()
        user32 = _user32()
        while not self._stopped.is_set():
            if user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, PM_REMOVE):
                if msg.message == WM_QUIT:
                    break
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))
            else:
                time.sleep(0.005)

    def stop(self):
        self._stopped.set()

    def uninstall(self):
        if self._hook:
            _user32().UnhookWindowsHookEx(self._hook)
            self._hook = None


def _wait_for_stop(event, hook):
    _kernel32().WaitForSingleObject(event, INFINITE)
    hook.stop()


# --------------------------------------------------------------------------------------------
# Phase 1 commands (unchanged).
# --------------------------------------------------------------------------------------------
def cmd_devices():
    import sounddevice as sd

    try:
        default_in, default_out = sd.default.device
    except Exception:
        default_in, default_out = None, None

    try:
        devices = sd.query_devices()
    except Exception as e:
        fail(tr(f"impossibile interrogare i dispositivi audio: {e}", f"cannot query the audio devices: {e}"))

    print(tr("Dispositivi audio (PortAudio):", "Audio devices (PortAudio):"))
    print(f"  {'ID':>3}  {'IN':>2} {'OUT':>3}  {tr('NOME', 'NAME')}")
    for i, d in enumerate(devices):
        marks = []
        if i == default_in:
            marks.append("default input")
        if i == default_out:
            marks.append("default output")
        tag = f"   <-- {', '.join(marks)}" if marks else ""
        print(f"  {i:>3}  {d['max_input_channels']:>2} {d['max_output_channels']:>3}  {d['name']}{tag}")

    if default_in is None:
        print(tr("\nNessun device di input di default: registrazione non disponibile.", "\nNo default input device: recording is not available."))
    else:
        print(f"\nDefault input: [{default_in}] {device_label(None)}")


def record(seconds: float, device) -> np.ndarray:
    import sounddevice as sd

    frames = int(round(seconds * SAMPLE_RATE))
    try:
        audio = sd.rec(frames, samplerate=SAMPLE_RATE, channels=1, dtype="float32", device=device)
        sd.wait()
    except sd.PortAudioError as e:
        fail(tr(f"microfono non disponibile o occupato: {e}", f"microphone unavailable or busy: {e}"))
    return audio[:, 0].copy()


def save_wav_int16(path: Path, audio: np.ndarray):
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())


def load_wav_int16(path: Path) -> np.ndarray:
    """Reads any mono/stereo WAV and brings it back to float32 mono 16 kHz."""
    if not path.exists():
        fail(tr(f"file non trovato: {path}", f"file not found: {path}"))
    try:
        with wave.open(str(path), "rb") as w:
            n_ch = w.getnchannels()
            width = w.getsampwidth()
            rate = w.getframerate()
            raw = w.readframes(w.getnframes())
    except wave.Error as e:
        fail(tr(f"WAV non valido ({path}): {e}", f"invalid WAV ({path}): {e}"))

    if width == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 1:
        data = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif width == 4:
        data = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        fail(tr(f"profondità WAV non supportata ({width * 8} bit): {path}", f"unsupported WAV bit depth ({width * 8} bit): {path}"))

    if n_ch > 1:
        data = data.reshape(-1, n_ch).mean(axis=1)

    # Whisper demands 16 kHz: if the file differs we interpolate, better than refusing the test.
    if rate != SAMPLE_RATE:
        n_out = int(round(len(data) * SAMPLE_RATE / rate))
        data = np.interp(
            np.linspace(0.0, len(data), n_out, endpoint=False),
            np.arange(len(data)),
            data,
        ).astype(np.float32)
    return data


def transcribe_clip(model, cfg: dict, audio: np.ndarray, vad: bool = False) -> str:
    """A whole clip in one go (--audio, --test, --serve). Raises on error.

    vad=True removes the silences before Whisper: the clip of a pressed button always has a
    little silence at the edges, and on silence Whisper invents sentences.
    """
    segments, _info = model.transcribe(audio, language=cfg["language"], vad_filter=vad)
    return "".join(seg.text for seg in segments).strip()


def transcribe(cfg: dict, audio: np.ndarray):
    model = get_model(cfg)
    t0 = time.perf_counter()
    try:
        text = transcribe_clip(model, cfg, audio)
    except Exception as e:
        fail(tr(f"trascrizione fallita: {e}", f"transcription failed: {e}"))
    elapsed = time.perf_counter() - t0
    return text, elapsed


def cmd_test(seconds: float, cfg: dict):
    import sounddevice as sd

    try:
        sd.check_input_settings(device=cfg["device"], samplerate=SAMPLE_RATE, channels=1, dtype="float32")
    except sd.PortAudioError as e:
        fail(tr(f"nessun input compatibile a {SAMPLE_RATE} Hz mono: {e}", f"no input compatible with {SAMPLE_RATE} Hz mono: {e}"))

    print(f"[voice] recording {seconds:g}s from the microphone...", file=sys.stderr)
    audio = record(seconds, cfg["device"])
    duration = len(audio) / SAMPLE_RATE

    wav_path = RUNTIME / "voice-last.wav"
    txt_path = RUNTIME / "voice-last.txt"
    save_wav_int16(wav_path, audio)

    text, elapsed = transcribe(cfg, audio)
    txt_path.write_text(text, encoding="utf-8")

    print(f"Device:            {device_label(cfg['device'])}")
    print(tr(f"Durata audio:      {duration:.2f} s", f"Audio length:      {duration:.2f} s"))
    print(tr(f"Trascrizione:      {elapsed:.2f} s", f"Transcription:     {elapsed:.2f} s"))
    print(f"WAV:               {wav_path}")
    print(tr(f"Testo ({len(text)} caratteri):", f"Text ({len(text)} characters):"))
    print(text if text else tr("(vuoto)", "(empty)"))


def cmd_audio(path: Path, cfg: dict):
    audio = load_wav_int16(path)
    duration = len(audio) / SAMPLE_RATE
    text, elapsed = transcribe(cfg, audio)

    print(f"File:              {path}")
    print(tr(f"Durata audio:      {duration:.2f} s", f"Audio length:      {duration:.2f} s"))
    print(tr(f"Trascrizione:      {elapsed:.2f} s", f"Transcription:     {elapsed:.2f} s"))
    print(tr(f"Testo ({len(text)} caratteri):", f"Text ({len(text)} characters):"))
    print(text if text else tr("(vuoto)", "(empty)"))


# --------------------------------------------------------------------------------------------
# Phase 2 commands: space key hook and kill switch.
# --------------------------------------------------------------------------------------------
def cmd_listen(cfg: dict, console_hwnd, parent_pid):
    if os.name != "nt":
        fail(tr("l'hook dello spazio richiede Windows", "the space hook requires Windows"))
    global _SINGLETON
    kernel32 = _kernel32()
    # The console to serve: the one passed by the launcher (which starts us hidden, with a console
    # of our own) or, started by hand in a terminal, our own, with the title that recognizes it.
    if console_hwnd is None:
        console_hwnd = kernel32.GetConsoleWindow()
        if not console_hwnd:
            fail(tr("nessuna console: lancia da un terminale o passa --console", "no console: run from a terminal or pass --console"))
        kernel32.SetConsoleTitleW(MANGO_TITLE)
    if not _user32().IsWindow(console_hwnd):
        fail(tr(f"--console {console_hwnd}: non e' una finestra", f"--console {console_hwnd}: not a window"))
    ctypes.set_last_error(0)
    _SINGLETON = kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if ctypes.get_last_error() == ERROR_ALREADY_EXISTS:
        fail(tr("mango-voice è già in ascolto; spegni prima con: python mango-voice.py --off", "mango-voice is already listening; stop it first with: python mango-voice.py --off"))

    stop_event = kernel32.CreateEventW(None, False, False, EVENT_NAME)
    if not stop_event:
        fail(tr("impossibile creare l'evento di stop", "cannot create the stop event"))

    controller = VoiceController(cfg, MangoWindow(console_hwnd).is_foreground)
    hook = SpaceHook(controller.handler)
    hook.install()

    print(
        f"[voice] listening: hold SPACE in the Mango Code terminal to dictate "
        f"(tap/hold {cfg['tap_hold_ms']} ms, model {cfg['model']}, console {console_hwnd}).\n"
        f"[voice] stop with: python mango-voice.py --off",
        file=sys.stderr,
    )
    threading.Thread(target=_wait_for_stop, args=(stop_event, hook), daemon=True).start()
    if parent_pid is not None:
        watch_parent(parent_pid, hook.stop)
    try:
        hook.pump()
    except KeyboardInterrupt:
        pass
    finally:
        hook.uninstall()
        kernel32.CloseHandle(stop_event)
        if _SINGLETON:
            kernel32.CloseHandle(_SINGLETON)
            _SINGLETON = None
    print("[voice] hook removed, exiting.", file=sys.stderr)


def cmd_off():
    if os.name != "nt":
        fail(tr("lo spegnimento dell'ascolto richiede Windows", "stopping the listener requires Windows"))
    kernel32 = _kernel32()
    handle = kernel32.OpenEventW(EVENT_MODIFY_STATE, False, EVENT_NAME)
    if not handle:
        print(tr("Nessuna istanza di mango-voice in ascolto.", "No mango-voice instance is listening."))
        return
    try:
        kernel32.SetEvent(handle)
    finally:
        kernel32.CloseHandle(handle)
    print(tr("Segnale di chiusura inviato: mango-voice si spegne.", "Stop signal sent: mango-voice is shutting down."))


# --------------------------------------------------------------------------------------------
# --serve: transcription for the web UI.
# The browser records with MediaRecorder (webm/opus) and sends the clip to the opencode server
# (POST /mango/voice/transcribe), which forwards it here: the page talks only to its own origin
# and this port stays an internal detail. A request with the Origin header therefore comes from
# a web page calling us directly, and is refused: no page must be able to use the service (or
# read its answers) by going around the server.
# --------------------------------------------------------------------------------------------
class TranscriptionService:
    """The model is loaded once, in a thread: the service answers at once (state "loading") and
    the transcriptions requested in the meantime wait for the load to finish."""

    MODEL_WAIT_S = 600  # the first start on a new machine downloads the model

    def __init__(self, cfg):
        self.cfg = cfg
        self._ready = threading.Event()
        self._error = None
        self._lock = threading.Lock()  # one transcription at a time: there is one processor

    def load(self):
        try:
            get_model(self.cfg)
            print(f"[voice] model '{self.cfg['model']}' ready.", file=sys.stderr)
        except Exception as e:
            self._error = tr(f"modello '{self.cfg['model']}' non caricato: {e}", f"model '{self.cfg['model']}' not loaded: {e}")
            print(f"[voice] {self._error}", file=sys.stderr)
        finally:
            self._ready.set()

    def status(self) -> dict:
        if self._error:
            return {"state": "error", "error": self._error, "model": self.cfg["model"]}
        return {"state": "ready" if self._ready.is_set() else "loading", "model": self.cfg["model"]}

    def transcribe(self, data: bytes) -> dict:
        """Returns {text, audio_s, elapsed_s}. ValueError = unreadable audio; RuntimeError = model."""
        from faster_whisper.audio import decode_audio

        try:
            audio = decode_audio(io.BytesIO(data), sampling_rate=SAMPLE_RATE)
        except Exception as e:
            raise ValueError(tr(f"audio non decodificabile: {e}", f"audio cannot be decoded: {e}"))
        if not self._ready.wait(self.MODEL_WAIT_S):
            raise RuntimeError(tr("il modello e' ancora in caricamento, riprova fra poco", "the model is still loading, try again shortly"))
        if self._error:
            raise RuntimeError(self._error)
        with self._lock:
            t0 = time.perf_counter()
            text = transcribe_clip(get_model(self.cfg), self.cfg, audio, vad=True)
            elapsed = time.perf_counter() - t0
        return {"text": text, "audio_s": round(len(audio) / SAMPLE_RATE, 2), "elapsed_s": round(elapsed, 2)}


def make_handler(service: TranscriptionService):
    from http.server import BaseHTTPRequestHandler

    class Handler(BaseHTTPRequestHandler):
        server_version = "mango-voice"

        def _json(self, status: int, body: dict):
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _from_web_page(self) -> bool:
            if self.headers.get("Origin") is None:
                return False
            self._json(403, {"error": tr("il servizio di trascrizione si usa tramite il server di Mango Code", "the transcription service is used through the Mango Code server")})
            return True

        def do_GET(self):
            if self._from_web_page():
                return
            if self.path == "/health":
                self._json(200, service.status())
                return
            self._json(404, {"error": tr("percorso sconosciuto", "unknown path")})

        def do_POST(self):
            if self._from_web_page():
                return
            if self.path != "/transcribe":
                self._json(404, {"error": tr("percorso sconosciuto", "unknown path")})
                return
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                self._json(411, {"error": tr("manca Content-Length", "Content-Length is missing")})
                return
            if length <= 0:
                self._json(400, {"error": tr("audio vuoto", "empty audio")})
                return
            if length > MAX_AUDIO_BYTES:
                limit_mb = MAX_AUDIO_BYTES // (1024 * 1024)
                self._json(413, {"error": tr(f"audio troppo lungo (oltre {limit_mb} MB)", f"audio too long (over {limit_mb} MB)")})
                return
            data = self.rfile.read(length)
            try:
                self._json(200, service.transcribe(data))
            except ValueError as e:
                self._json(422, {"error": str(e)})
            except RuntimeError as e:
                self._json(503, {"error": str(e)})
            except Exception as e:
                self._json(500, {"error": tr(f"trascrizione fallita: {e}", f"transcription failed: {e}")})

        def log_message(self, fmt, *args):
            print(f"[voice] {self.address_string()} {fmt % args}", file=sys.stderr)

    return Handler


def cmd_serve(cfg: dict, port: int, parent_pid):
    from http.server import ThreadingHTTPServer

    service = TranscriptionService(cfg)
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(service))
    except OSError as e:
        fail(tr(f"porta {port} non disponibile: {e}", f"port {port} not available: {e}"))
    server.daemon_threads = True
    threading.Thread(target=service.load, daemon=True).start()
    if parent_pid is not None:
        watch_parent(parent_pid, server.shutdown)
    print(f"[voice] transcription service on http://127.0.0.1:{port} (model {cfg['model']}).", file=sys.stderr)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    print("[voice] service closed, exiting.", file=sys.stderr)


def main():
    p = argparse.ArgumentParser(
        prog="mango-voice.py",
        description=tr("Trascrizione vocale locale (faster-whisper, CPU) per mango-code.", "Local voice transcription (faster-whisper, CPU) for mango-code."),
    )
    g = p.add_mutually_exclusive_group()
    g.add_argument("--listen", action="store_true", help=tr("avvia l'hook dello spazio (default)", "start the space hook (default)"))
    g.add_argument("--off", action="store_true", help=tr("spegni l'istanza in ascolto", "stop the listening instance"))
    g.add_argument("--devices", action="store_true", help=tr("elenca i dispositivi audio e il default input", "list the audio devices and the default input"))
    g.add_argument("--test", type=float, metavar=tr("SECONDI", "SECONDS"), help=tr("registra N secondi dal microfono e trascrive", "record N seconds from the microphone and transcribe"))
    g.add_argument("--audio", metavar="FILE.WAV", help=tr("trascrive un wav esistente", "transcribe an existing wav"))
    g.add_argument("--serve", action="store_true", help=tr("servizio HTTP di trascrizione per la web UI", "HTTP transcription service for the web UI"))
    g.add_argument("--print-console", action="store_true", help=tr("stampa la finestra della console (per il launcher)", "print the console window (for the launcher)"))
    p.add_argument("--port", type=int, default=SERVE_PORT, help=tr(f"con --serve: la porta (default {SERVE_PORT})", f"with --serve: the port (default {SERVE_PORT})"))
    p.add_argument("--console", type=int, metavar="HWND", help=tr("con --listen: la console di Mango Code da servire", "with --listen: the Mango Code console to serve"))
    p.add_argument("--parent", type=int, metavar="PID", help=tr("esci quando termina questo processo", "exit when this process ends"))
    args = p.parse_args()

    if args.print_console:
        print(_kernel32().GetConsoleWindow() or 0)
        return

    if args.devices:
        cmd_devices()
        return

    if args.off:
        cmd_off()
        return

    if not EXAMPLE_PATH.exists():
        EXAMPLE_PATH.write_text(
            json.dumps(EXAMPLE, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )

    if args.test is not None:
        if args.test <= 0:
            fail(tr("--test richiede un numero di secondi > 0", "--test needs a number of seconds > 0"))
        cmd_test(args.test, load_config())
        return

    if args.audio is not None:
        cmd_audio(Path(args.audio), load_config())
        return

    if args.serve:
        cmd_serve(load_config(), args.port, args.parent)
        return

    cmd_listen(load_config(), args.console, args.parent)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
