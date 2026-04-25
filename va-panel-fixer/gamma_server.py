"""
VA Panel Fixer — Windows Gamma Control Server
=============================================
Controls the ACTUAL Windows display gamma via SetDeviceGammaRamp
(same API that f.lux, NVIDIA Control Panel etc. use).

Listens on ws://localhost:7891 for correction commands from the browser app.
Run this FIRST, then open http://localhost:7890 in your browser.

Install deps:  pip install websockets
Run:           python gamma_server.py
"""

import asyncio
import json
import math
import ctypes
import sys
import time

try:
    import websockets
except ImportError:
    print("\n[!] Missing dependency. Installing websockets...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "websockets"])
    import websockets

# ─── Safety Limits ───────────────────────────────────────────────────────────
# These HARD limits prevent the screen from ever going black or unusable.
# Even if the browser sends extreme values, these caps are enforced.
MAX_DARKEN     = 0.32   # brightness can never reduce more than 32%
MAX_BRIGHTEN   = 0.45   # brightness can never increase more than 45%
MIN_RAMP_VALUE = 7000   # every ramp entry >= this (~10.7% of 65535) — no pure black
MAX_RAMP_VALUE = 65535  # every ramp entry <= 65535

# Ramp interpolation — blends current → target at this speed (0.0-1.0)
# Lower = slower/smoother but safer. 0.25 = 25% of the way each frame.
RAMP_LERP = 0.22

# ─── State ───────────────────────────────────────────────────────────────────
# Keep the current live ramp so we can smoothly interpolate
_current_ramp = None

gdi32  = ctypes.windll.gdi32
user32 = ctypes.windll.user32

# Gamma ramp: 256 WORD values per channel (R, G, B) = 768 total
GammaRamp = ctypes.c_uint16 * 768

def build_gamma_ramp(brightness: float, contrast: float, gamma: float, saturation: float) -> GammaRamp:
    """
    Build a Windows GDI gamma ramp with HARD safety clamps.
    The display will NEVER go black regardless of input values.

    brightness : -MAX_DARKEN to +MAX_BRIGHTEN  (0 = unchanged)
    contrast   :  0.7 to 1.8                   (1 = unchanged)
    gamma      :  0.4 to 2.5                   (1 = unchanged)
    saturation :  0.7 to 1.8                   (1 = unchanged)
    """
    # ── HARD CLAMP ALL INPUTS before doing anything ──
    brightness = max(-MAX_DARKEN,  min(MAX_BRIGHTEN, brightness))
    contrast   = max(0.70,         min(1.80,         contrast))
    gamma      = max(0.40,         min(2.50,         gamma))
    saturation = max(0.70,         min(1.80,         saturation))
    safe_g     = max(0.1,          gamma)
    ramp = GammaRamp()

    for i in range(256):
        x = i / 255.0

        # 1. Gamma curve  (corrects VA midtone crush/wash)
        x = math.pow(max(x, 0.0), 1.0 / safe_g)

        # 2. Contrast stretch around midpoint
        x = (x - 0.5) * contrast + 0.5

        # 3. Brightness lift / reduce
        x = x + brightness * 0.55

        # Clamp to valid range
        x   = max(0.0, min(1.0, x))
        val = int(x * 65535)

        # ── MINIMUM FLOOR: never allow full black ──
        val = max(val, MIN_RAMP_VALUE)
        val = min(val, MAX_RAMP_VALUE)

        ramp[i]       = val   # R
        ramp[256 + i] = val   # G
        ramp[512 + i] = val   # B

    # ── Saturation via per-channel bias ──────────────────────────────────────
    # VA panels desaturate at angles. We simulate saturation by pushing R/B in
    # opposite directions (red boost + blue cut for warm-boost, etc.).
    # Here we simply boost all channels equally but pull B slightly for >1 sat.
    if abs(saturation - 1.0) > 0.02:
        sat_delta = (saturation - 1.0) * 0.06
        for i in range(256):
            r = ramp[i]       + int(sat_delta * 65535 * (i / 255))
            g = ramp[256 + i] + int(sat_delta * 0.6 * 65535 * (i / 255))
            b = ramp[512 + i] - int(sat_delta * 0.4 * 65535 * (i / 255))
            # Apply floor AND ceiling to every per-channel value
            ramp[i]       = max(MIN_RAMP_VALUE, min(MAX_RAMP_VALUE, r))
            ramp[256 + i] = max(MIN_RAMP_VALUE, min(MAX_RAMP_VALUE, g))
            ramp[512 + i] = max(MIN_RAMP_VALUE, min(MAX_RAMP_VALUE, b))

    return ramp

def reset_gamma():
    """Restore Windows identity (flat/linear) gamma ramp."""
    global _current_ramp
    ramp = GammaRamp()
    for i in range(256):
        v = i * 257
        ramp[i]       = v
        ramp[256 + i] = v
        ramp[512 + i] = v
    hdc = user32.GetDC(None)
    gdi32.SetDeviceGammaRamp(hdc, ramp)
    user32.ReleaseDC(None, hdc)
    _current_ramp = list(ramp)  # track state


def apply_gamma(brightness, contrast, gamma, saturation):
    """Smoothly interpolate from current ramp to target ramp, then apply."""
    global _current_ramp

    target = build_gamma_ramp(brightness, contrast, gamma, saturation)

    # Init current ramp on first call
    if _current_ramp is None:
        _current_ramp = list(target)

    # Lerp: current + (target - current) * RAMP_LERP
    blended = GammaRamp()
    for i in range(768):
        cur = _current_ramp[i]
        tgt = target[i]
        blended[i] = int(cur + (tgt - cur) * RAMP_LERP)
        # Enforce floor/ceiling on blended value too
        blended[i] = max(MIN_RAMP_VALUE, min(MAX_RAMP_VALUE, blended[i]))

    hdc = user32.GetDC(None)
    ok  = gdi32.SetDeviceGammaRamp(hdc, blended)
    user32.ReleaseDC(None, hdc)

    _current_ramp = list(blended)  # update state
    return bool(ok)

# ─── WebSocket Server ─────────────────────────────────────────────────────────
CLIENTS = set()

async def handler(ws):
    CLIENTS.add(ws)
    addr = ws.remote_address
    print(f"  [OK] Browser connected: {addr[0]}:{addr[1]}")

    try:
        async for msg in ws:
            try:
                data       = json.loads(msg)
                cmd        = data.get("cmd", "apply")

                if cmd == "ping":
                    await ws.send(json.dumps({"ok": True, "msg": "pong"}))
                    continue

                if cmd == "reset":
                    reset_gamma()
                    await ws.send(json.dumps({"ok": True, "msg": "reset"}))
                    continue

                brightness = float(data.get("brightness",  0.0))
                contrast   = float(data.get("contrast",    1.0))
                gamma      = float(data.get("gamma",       1.0))
                saturation = float(data.get("saturation",  1.0))

                ok = apply_gamma(brightness, contrast, gamma, saturation)
                await ws.send(json.dumps({
                    "ok":   ok,
                    "b":    round(brightness, 3),
                    "c":    round(contrast, 3),
                    "g":    round(gamma, 3),
                    "s":    round(saturation, 3),
                }))

            except Exception as e:
                await ws.send(json.dumps({"ok": False, "error": str(e)}))

    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        CLIENTS.discard(ws)
        print(f"  [Disconnected] Browser disconnected — resetting display gamma")
        reset_gamma()   # Safety: restore normal display on disconnect

# ─── Entry Point ─────────────────────────────────────────────────────────────
async def main():
    print("=" * 55)
    print("  VA Panel Fixer — Windows Gamma Control Server")
    print("=" * 55)
    print(f"  WebSocket : ws://localhost:7891")
    print(f"  Browser   : http://localhost:7890")
    print("  Press Ctrl+C to stop (gamma will be reset)\n")

    # Test that gdi32 is accessible
    try:
        reset_gamma()
        print("  [OK] Windows SetDeviceGammaRamp: OK\n")
    except Exception as e:
        print(f"  [!] WARNING: Cannot control display gamma: {e}")
        print("    (Try running as Administrator)\n")

    try:
        async with websockets.serve(handler, "localhost", 7891, ping_interval=5):
            await asyncio.Future()   # run forever
    except KeyboardInterrupt:
        pass
    finally:
        print("\n  Resetting display to normal...")
        reset_gamma()
        print("  Done. Goodbye!")

if __name__ == "__main__":
    asyncio.run(main())
