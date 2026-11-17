# OpenPong Companion

Runs on the **end-user's own computer**. It opens ONE outbound WebSocket to the
relay, registers with the pairing token minted for that owner, then multiplexes
the relay's CDP requests to the user's own local Chrome and handles the
`wait_for_human` gate prompt. No credentials are ever read, stored, or forwarded
— the user logs into sites themselves, in their own Chrome tab.

## Files

| File | Purpose |
|---|---|
| `companion.py` | The process: tunnel, dispatch, gate handshake. |
| `chrome.py` | Finds/launches the user's Chrome with remote debugging on `localhost:9222`, using a **dedicated** profile. |
| `gate_ui.py` | The local `127.0.0.1` prompt shown on `GATE_OPEN` (CSRF-protected with a per-gate nonce). |
| `companion_protocol.py` | Wire `type` constants (renamed from `protocol.py` to avoid a sys.path clash with the relay's `protocol.py`). |
| `test_companion.py` | Integration test against a **fake CDP endpoint** + fake relay. |

## Run it

Get a pairing command from the dashboard (Settings → Your computer → **Pair this
computer**), then on the computer that stays logged in to OmniPong:

```bash
cd services/omnipong/companion
pip install -r requirements.txt
python companion.py --relay-base-url wss://relay.example --pairing-token rt_…
```

- `--chrome-port` (default `9222`), `--gate-ui-port` (default `8765`),
  `--no-launch-chrome` (reuse an already-running debug Chrome).
- The dedicated Chrome profile lives at
  `~/Library/Application Support/openpong/chrome-profile` (macOS) or
  `%LOCALAPPDATA%\openpong\chrome-profile` (Windows); override with
  `OPENPONG_CHROME_PROFILE_DIR`. It is never the user's everyday profile.
- `--register-token` is accepted as an alias for `--pairing-token`.

## Self-check

```bash
cd services/omnipong/companion
python -m pytest test_companion.py -v
```

The fake Chrome is an aiohttp app that echoes devtools frames; the fake relay
drives the protocol. It proves register, the CDP HTTP discovery proxy (raw,
unrewritten body), the devtools channel round trip, and the gate handshake two
ways (the user clicks Continue; the relay clears the gate from the dashboard).
It does **not** prove a real Chrome + real relay round trip.
