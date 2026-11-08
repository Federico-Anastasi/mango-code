#!/usr/bin/env python3
# mango-voice-test.py - tests of the pure logic of mango-voice.py.
#
# It does not touch Windows, the microphone or the model: it tests the tap/hold state machine,
# the filter of signed events, the window choice (only the Mango Code console) and the config
# validation. Run with:
#
#   python mango-voice-test.py

import importlib.util
import sys
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent


def load_module():
    spec = importlib.util.spec_from_file_location("mango_voice", SCRIPT_DIR / "mango-voice.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["mango_voice"] = module
    spec.loader.exec_module(module)
    return module


mv = load_module()


class FakeScheduler:
    """Manual scheduler: the tap/hold threshold does not fire 'by itself', the test fires it."""

    def __init__(self):
        self.queue = []

    def __call__(self, delay, cb):
        self.queue.append(cb)

        def cancel():
            if cb in self.queue:
                self.queue.remove(cb)

        return cancel

    def fire(self):
        if not self.queue:
            raise AssertionError("no callback waiting to fire")
        self.queue.pop(0)()


class EventLog:
    def __init__(self, active=None):
        self.events = []
        self.scheduler = FakeScheduler()
        self.handler = mv.SpaceKeyHandler(
            300,
            lambda: self.events.append("start"),
            lambda: self.events.append("stop"),
            lambda: self.events.append("tap"),
            schedule=self.scheduler,
            active=active,
        )


class TestTapHold(unittest.TestCase):
    def test_tap_released_before_threshold_forwards_one_space(self):
        r = EventLog()
        self.assertTrue(r.handler.press())
        self.assertEqual(r.events, [])          # the decision is taken at release
        self.assertTrue(r.handler.release())
        self.assertEqual(r.events, ["tap"])
        self.assertEqual(r.scheduler.queue, [])  # the threshold was cancelled

    def test_hold_past_threshold_starts_listening(self):
        r = EventLog()
        self.assertTrue(r.handler.press())
        self.assertEqual(len(r.scheduler.queue), 1)
        r.scheduler.fire()
        self.assertEqual(r.events, ["start"])
        self.assertTrue(r.handler.release())
        self.assertEqual(r.events, ["start", "stop"])

    def test_auto_repeat_suppressed_without_restarting(self):
        r = EventLog()
        r.handler.press()
        r.scheduler.fire()
        self.assertTrue(r.handler.press())      # auto-repeat 1
        self.assertTrue(r.handler.press())      # auto-repeat 2
        self.assertEqual(r.events, ["start"])
        self.assertEqual(len(r.scheduler.queue), 0)  # no new threshold armed

    def test_release_after_tap_does_not_start_listening(self):
        r = EventLog()
        r.handler.press()
        r.handler.release()                     # tap: the threshold is cancelled
        r.scheduler.fire() if r.scheduler.queue else None
        self.assertEqual(r.events, ["tap"])

    def test_repeated_tap_hold_tap_cycles(self):
        r = EventLog()
        r.handler.press()
        r.handler.release()
        r.handler.press()
        r.scheduler.fire()
        r.handler.release()
        r.handler.press()
        r.handler.release()
        self.assertEqual(r.events, ["tap", "start", "stop", "tap"])

    def test_release_without_press_does_nothing(self):
        r = EventLog()
        self.assertTrue(r.handler.release())
        self.assertEqual(r.events, [])


class TestOutsideMango(unittest.TestCase):
    """In a window that is not Mango Code space passes intact and we never listen."""

    def test_press_elsewhere_passes_whole(self):
        r = EventLog(active=lambda: False)
        self.assertFalse(r.handler.press())
        self.assertFalse(r.handler.press())     # auto-repeat
        self.assertFalse(r.handler.release())
        self.assertEqual(r.events, [])          # no forwarded tap: the real space went through
        self.assertEqual(r.scheduler.queue, [])  # no threshold armed, so no listening

    def test_decided_at_press_not_midway(self):
        inside = [False]
        r = EventLog(active=lambda: inside[0])
        self.assertFalse(r.handler.press())
        inside[0] = True                        # the window changes while the key is down
        self.assertFalse(r.handler.press())
        self.assertFalse(r.handler.release())
        self.assertTrue(r.handler.press())      # the next press is ours
        r.scheduler.fire()
        self.assertTrue(r.handler.release())
        self.assertEqual(r.events, ["start", "stop"])

    def test_listening_does_not_stop_if_the_window_changes(self):
        inside = [True]
        r = EventLog(active=lambda: inside[0])
        r.handler.press()
        r.scheduler.fire()
        inside[0] = False
        self.assertTrue(r.handler.press())      # auto-repeat of our press
        self.assertTrue(r.handler.release())
        self.assertEqual(r.events, ["start", "stop"])


class TestMangoWindow(unittest.TestCase):
    WT = mv.WINDOWS_TERMINAL_CLASS

    def test_conhost_console_in_foreground(self):
        self.assertTrue(mv.is_mango_window(10, 10, 10, "ConsoleWindowClass", "any"))

    def test_conhost_other_window(self):
        self.assertFalse(mv.is_mango_window(11, 10, 10, "ConsoleWindowClass", mv.MANGO_TITLE))

    def test_windows_terminal_mango_tab(self):
        self.assertTrue(mv.is_mango_window(20, 5, 20, self.WT, mv.MANGO_TITLE))

    def test_windows_terminal_other_tab_same_window(self):
        self.assertFalse(mv.is_mango_window(20, 5, 20, self.WT, "PowerShell"))

    def test_windows_terminal_other_window_with_the_right_title(self):
        self.assertFalse(mv.is_mango_window(21, 5, 20, self.WT, mv.MANGO_TITLE))

    def test_browser_with_mango_code_title(self):
        self.assertFalse(mv.is_mango_window(30, 5, 20, "Chrome_WidgetWin_1", "Mango Code - Google Chrome"))

    def test_no_window(self):
        self.assertFalse(mv.is_mango_window(0, 5, 20, "", ""))
        self.assertFalse(mv.is_mango_window(20, 0, None, self.WT, mv.MANGO_TITLE))


class TestSignedFilter(unittest.TestCase):
    def test_event_signed_by_us_is_ignored(self):
        self.assertTrue(mv.is_own_event(mv.VOICE_SIGNATURE))

    def test_normal_event_is_not_signed(self):
        self.assertFalse(mv.is_own_event(0))
        self.assertFalse(mv.is_own_event(12345))

    def test_similar_different_signature_not_counted(self):
        self.assertFalse(mv.is_own_event(mv.VOICE_SIGNATURE + 1))


class TestConfig(unittest.TestCase):
    def test_valid_defaults(self):
        cfg = mv._validate_config(dict(mv.DEFAULTS))
        self.assertEqual(cfg["tap_hold_ms"], 300)
        self.assertEqual(cfg["max_window_s"], 20.0)

    def test_negative_tap_hold_rejected(self):
        cfg = dict(mv.DEFAULTS, tap_hold_ms=-1)
        with self.assertRaises(ValueError):
            mv._validate_config(cfg)

    def test_empty_model_rejected(self):
        cfg = dict(mv.DEFAULTS, model="   ")
        with self.assertRaises(ValueError):
            mv._validate_config(cfg)

    def test_non_numeric_values_rejected(self):
        cfg = dict(mv.DEFAULTS, poll_ms="soon")
        with self.assertRaises(ValueError):
            mv._validate_config(cfg)


if __name__ == "__main__":
    unittest.main(verbosity=2)
