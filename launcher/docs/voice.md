# Voice — dictating instructions to mango-code

In the Mango Code terminal you can talk instead of typing: **hold the space bar** and it starts listening, the text is
**typed into the terminal** while you speak, and on release it stops. Everything is local, on the CPU
(faster-whisper): the transcription is a separate model, so it takes nothing from the language model's context and
uses no GPU.

It is on by default when `mango-code` starts. `-NoVoice` turns it off for that session. A quick tap of space stays a
normal space.

## How it works

`launcher/mango-voice.py` has two modes.

**Space-key hook (the terminal).** A low-level global keyboard hook (`SetWindowsHookExW`, `WH_KEYBOARD_LL`, through
`ctypes`: no extra dependency) watches the space bar, only while the Mango Code console is the foreground window; in
every other window space is untouched. A small state machine separates tap from hold: released before `tap_hold_ms`,
it forwards **one** space; held longer, it starts listening and swallows the auto-repeat and the key-up.

- The text is typed by sentences. The audio is transcribed with `vad_filter=True`; a segment is typed only once it is
  followed by `finalize_lag_ms` of silence, then the audio already written is discarded (sliding window, closed
  anyway after `max_window_s`). There is no automatic Enter.
- The events the script injects with `SendInput` carry `dwExtraInfo` = `0x4D414E47` ("MANG"); the hook recognizes them
  and lets them through, so the typed text does not re-enter the hook. If the hook fails, space goes back to passing
  normally.
- One instance at a time (mutex `mango-voice-singleton-v1`). When the process dies the hook dies with it, and
  `python mango-voice.py --off` stops it (event `mango-voice-stop-v1`).
- `mango-code` starts it in the background, tied to the session (`--parent`), and shuts it down when the session ends.
  The log is in `runtime\logs\voice-*.log`. A cost to know: while it runs, every space in the Mango Code console is
  delivered on release, and holding space there starts listening.

**Transcription service (the web UI).** With `-Web` there is no hook: `python mango-voice.py --serve` starts an HTTP
service on `127.0.0.1:4097` that transcribes the audio the page records with its microphone button. The page talks
only to its own origin; the web server forwards the audio to this service (`POST /transcribe`).

## Configuration

`launcher/mango-voice.json`, a copy of `mango-voice.example.json` (all keys are optional):

| Key | Default | Meaning |
|---|---|---|
| `model` | `small` | faster-whisper model (`tiny`, `base`, `small`, `medium`, `large-v3`) |
| `language` | `it` | ISO-639-1 code passed to Whisper |
| `device` | `null` | input microphone, index as in `--devices` or name; `null` = system default |
| `compute_type` | `int8` | CPU quantization |
| `tap_hold_ms` | `300` | below this a press of space is a tap, above it the script listens |
| `poll_ms` | `400` | how often the accumulated window is transcribed |
| `finalize_lag_ms` | `700` | silence needed after a segment before it is typed |
| `min_audio_ms` | `400` | less audio than this is not transcribed |
| `max_window_s` | `20` | beyond this the window is closed without waiting for silence |

The audio is captured as 16 kHz mono, which is what Whisper expects. The script needs `sounddevice`, `numpy` and
`faster_whisper`, plus the standard library.

## Testing

```powershell
python mango-voice.py --devices          # lists the audio devices and marks the default input
python mango-voice.py --test 3           # records 3 s, writes runtime/voice-last.wav and runtime/voice-last.txt,
                                         # transcribes and prints the timings
python mango-voice.py --audio file.wav   # transcribes an existing wav (no microphone needed)
python mango-voice-test.py               # unit tests of the pure logic: tap/hold, auto-repeat, signed events,
                                         # window choice, config validation (no Windows, microphone or model)
```

To try the hook by hand:

```powershell
python mango-voice.py                    # starts listening
# in the Mango Code console: hold SPACE and speak, then release. The text appears as you speak.
python mango-voice.py --off              # turns it off
```

Errors (missing microphone or model, bad config) end with a clear message and exit code 2, without a traceback.
