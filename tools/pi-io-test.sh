#!/bin/bash
# The Pi's three interfaces, walked through with a person in the room:
#   audio OUT (HDMI to the television), audio IN (the ReSpeaker), and HDMI-CEC (the television's own bus).
#
# Run it on the Pi, from a terminal you can see and a chair near the microphone:
#     ssh -t user@pi 'bash ~/hearth/tools/pi-io-test.sh'
#
# It changes things — it dips the HDMI sink volume (and puts it back), puts the television into
# standby and wakes it, and presses its volume keys — so it asks before it starts. Every line of the
# verdict says how it is known, because a test that says "OK" about something nobody read back
# is the thing this repo exists to avoid:
#   VERIFIED     a machine read the result back (a volume read from the sink, a power state from the TV)
#   CONFIRMED    a person said they saw or heard it; nothing read it back
#   UNVERIFIED   it was done and there is no way to know
#   UNSUPPORTED  the other side said it cannot (a CEC Feature Abort)
#   FAILED       it was tried and did not work
#
# Needs: arecord, aplay, espeak-ng, wpctl, cec-ctl, ffmpeg (for levels). Not run by CI.
set -u
CLI="${HEARTH_CLI:-$HOME/hearth/apps/cli/dist/main.js}"
CEC=${HEARTH_CEC_DEV:-/dev/cec0}
LOG="$HOME/hearth-io-test-$(date +%Y%m%d-%H%M).log"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
export PATH="$HOME/.local/node/bin:$PATH"

declare -a ROWS
row() { ROWS+=("$(printf '%-12s %-34s %s' "$1" "$2" "$3")"); echo "  -> $1: $2 — $3" | tee -a "$LOG"; }
say()  { echo "$*" | tee -a "$LOG"; }
ask()  { local a; read -r -p "$1 [y/n] " a; echo "$1 -> $a" >> "$LOG"; [[ "$a" =~ ^[Yy] ]]; }
level() { # wav -> "mean_dB max_dB"
  ffmpeg -hide_banner -nostats -i "$1" -af volumedetect -f null - 2>&1 | awk '/mean_volume/ {m=$5} /max_volume/ {x=$5} END {print m, x}'; }
tvpower() { cec-ctl -d "$CEC" --to 0 --give-device-power-status 2>&1 | awk '/pwr-state/ {print $2}'; }
waitfor() { local t=0; while [ $t -lt "$2" ]; do [ "$(tvpower)" = "$1" ] && return 0; sleep 1; t=$((t+1)); done; return 1; }
sink() { wpctl get-volume @DEFAULT_AUDIO_SINK@ | awk '{print $2}'; }

say "Hearth I/O walk-through  $(date)"
say "Log: $LOG"
say "Power: $(vcgencmd get_throttled)  (0x0 is clean; anything else makes timings meaningless)"
echo
echo "This will: dip the HDMI volume and restore it, play spoken test phrases, record you twice,"
echo "put the television into STANDBY and wake it, and press its volume keys."
ask "Go ahead?" || { say "Cancelled."; exit 1; }

# ---------------------------------------------------------------- audio IN: the room
say; say "== 1. Microphone, quiet room — please stay silent for 3 seconds"
arecord -D default -f S16_LE -r 16000 -c 1 -d 3 -q "$WORK/room.wav" 2>>"$LOG"
if [ -s "$WORK/room.wav" ]; then
  read -r room_mean room_max < <(level "$WORK/room.wav")
  row VERIFIED "mic captures (room ${room_mean} dB mean)" "arecord wrote audio from the default device"
else
  row FAILED "mic captures" "arecord produced nothing; see $LOG"
fi

# ---------------------------------------------------------------- audio OUT
say; say "== 2. Speaker — spoken phrases through HDMI to the television"
orig=$(sink)
wpctl set-volume @DEFAULT_AUDIO_SINK@ 0.5; sleep 0.5
[ "$(sink)" = "0.50" ] && row VERIFIED "sink volume write + read-back" "set 0.50, read $(sink)" || row FAILED "sink volume write + read-back" "set 0.50, read $(sink)"
espeak-ng "Hearth audio test. One, two, three." 2>>"$LOG"
espeak-ng -v cmn "你好，這是音訊測試。" 2>>"$LOG"
if ask "Did you hear BOTH phrases (English, then Mandarin) from the television's speakers?"; then
  row CONFIRMED "speech reaches the TV speakers" "a person heard English and Mandarin"
else
  row FAILED "speech reaches the TV speakers" "not heard; check TV input/mute and the HDMI sink"
fi

say; say "== 3. Does the microphone hear the television? (a box that hears itself answers itself)"
arecord -D default -f S16_LE -r 16000 -c 1 -d 4 -q "$WORK/self.wav" 2>>"$LOG" &
rec=$!; sleep 0.5; espeak-ng "Hearth audio test. One, two, three." 2>>"$LOG"; wait $rec
read -r self_mean self_max < <(level "$WORK/self.wav")
say "   quiet room: mean ${room_mean:-?} dB, max ${room_max:-?} dB   while it spoke: mean ${self_mean} dB, max ${self_max} dB"
row VERIFIED "mic level while the TV speaks" "${self_mean} dB mean vs ${room_mean:-?} dB quiet (the gate must hold the mic shut while it speaks)"
wpctl set-volume @DEFAULT_AUDIO_SINK@ "$orig"; sleep 0.3
[ "$(sink)" = "$orig" ] && row VERIFIED "sink volume restored" "$orig" || row FAILED "sink volume restored" "wanted $orig, read $(sink)"

# ---------------------------------------------------------------- audio IN: you
say; say "== 4. Your voice — two recordings, played back, then transcribed on this box"
say "   After each prompt ('speak') say the phrase once, at the volume you would use to a television."
read -r -p "   Press Enter, then say:  \"hearth, turn it down\"  " _
espeak-ng "speak" 2>>"$LOG"; arecord -D default -f S16_LE -r 16000 -c 1 -d 4 -q "$WORK/en.wav" 2>>"$LOG"
read -r -p "   Press Enter, then say:  \"打開電視\"  " _
espeak-ng "speak" 2>>"$LOG"; arecord -D default -f S16_LE -r 16000 -c 1 -d 4 -q "$WORK/zh.wav" 2>>"$LOG"
for k in en zh; do
  read -r mean max < <(level "$WORK/$k.wav")
  say "   $k: mean $mean dB, max $max dB  (quiet room was ${room_mean:-?} dB mean)"
done
if ask "Play both recordings back through the television — OK?"; then
  aplay -q "$WORK/en.wav" 2>>"$LOG"; aplay -q "$WORK/zh.wav" 2>>"$LOG"
  ask "Did they sound like you, clearly?" \
    && row CONFIRMED "mic -> file -> speaker round trip" "a person recognised their own voice" \
    || row FAILED "mic -> file -> speaker round trip" "recording unclear or silent (wrong channel? gain?)"
fi

if [ -f "$CLI" ] && [ -n "${HEARTH_STT_MODEL_PATH:-}" ] && [ -n "${HEARTH_STT_RUNTIME_PATH:-}" ]; then
  say; say "   Transcribing with the offline model (the model takes ~20 s to load)..."
  mkdir -p "$WORK/rec"; cp "$WORK/en.wav" "$WORK/rec/en.wav"; cp "$WORK/zh.wav" "$WORK/rec/zh.wav"
  cat > "$WORK/manifest.json" <<JSON
{ "items": [ {"id":"en","audio":"rec/en.wav","expected":"hearth turn it down","language":"en"},
             {"id":"zh","audio":"rec/zh.wav","expected":"打開電視","language":"zh"} ] }
JSON
  node "$CLI" stt bench "$WORK/manifest.json" --quiet 2>>"$LOG" > "$WORK/bench.json"
  node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); for (const x of r.results) console.log("   "+x.id+": heard "+JSON.stringify(x.actual)+"  (expected "+JSON.stringify(x.expected)+", error rate "+(x.cer==null?"-":x.cer.toFixed(2))+")")' "$WORK/bench.json" | tee -a "$LOG"
  row UNVERIFIED "offline transcription of your voice" "see the two lines above: whether 'hearth' came out as a word the wake match accepts is the point"
else
  say "   (skipping transcription: set HEARTH_STT_MODEL_PATH and HEARTH_STT_RUNTIME_PATH, and build the CLI)"
fi

# ---------------------------------------------------------------- CEC
say; say "== 5. HDMI-CEC — the television, over the bus"
if [ ! -e "$CEC" ]; then row FAILED "CEC adapter" "$CEC does not exist"; else
  # A freshly booted adapter has no logical address, and every transmit then prints "Adapter is
  # unconfigured" and gets no answer — which looks exactly like a TV that ignores you. (This script
  # once reported "TV answers on CEC: FAILED" for that reason on 2026-10-14.) Hearth claims one on
  # its first transmit; so must this.
  if ! cec-ctl -d "$CEC" 2>&1 | grep -q 'Logical Addresses *: [1-9]'; then
    cec-ctl -d "$CEC" --playback >/dev/null 2>&1
    say "   (the adapter had no logical address — normal after a reboot; claimed one with cec-ctl --playback)"
  fi
  p0=$(tvpower)
  if [ -z "$p0" ]; then row FAILED "TV answers on CEC" "no reply to Give Device Power Status"; else
    row VERIFIED "TV answers on CEC" "power state '$p0'; $(cec-ctl -d "$CEC" --to 0 --give-device-vendor-id 2>&1 | awk '/vendor-id/ {print $2,$3}')"
    say "   Putting the television into standby in 3 seconds..."; sleep 3
    cec-ctl -d "$CEC" --to 0 --standby >/dev/null 2>&1
    if waitfor standby 15; then row VERIFIED "CEC standby" "TV reported 'standby'"; else row FAILED "CEC standby" "TV still '$(tvpower)'"; fi
    cec-ctl -d "$CEC" --to 0 --image-view-on >/dev/null 2>&1
    if ! waitfor on 15; then
      cec-ctl -d "$CEC" --to 0 --user-control-pressed ui-cmd=power-on-function >/dev/null 2>&1
      cec-ctl -d "$CEC" --to 0 --user-control-released >/dev/null 2>&1
    fi
    if waitfor on 15; then row VERIFIED "CEC wake" "TV reported 'on'"; else row FAILED "CEC wake" "TV '$(tvpower)'; use the remote"; fi
    cec-ctl -d "$CEC" --active-source phys-addr=3.0.0.0 >/dev/null 2>&1
    ask "Did the television go dark and come back with the Pi's picture?" \
      && row CONFIRMED "TV went dark and returned on HDMI 3" "a person saw it" \
      || row UNVERIFIED "TV picture after wake" "power state read back, picture not confirmed"

    say "   Pressing the television's own volume keys (up, then down)..."
    audio=$(cec-ctl -d "$CEC" --to 0 --give-audio-status 2>&1)
    echo "$audio" | grep -q FEATURE_ABORT && row UNSUPPORTED "CEC audio status from the TV" "Feature Abort: it will not report its volume to a playback device"
    for k in volume-up volume-down; do
      cec-ctl -d "$CEC" --to 0 --user-control-pressed ui-cmd=$k >/dev/null 2>&1
      cec-ctl -d "$CEC" --to 0 --user-control-released >/dev/null 2>&1; sleep 1
    done
    if ask "Did the television's OWN volume indicator move (a bar or number on screen)?"; then
      row CONFIRMED "CEC volume keys move the TV volume" "a person saw the indicator; nothing read it back"
    else
      row UNVERIFIED "CEC volume keys" "sent, no acknowledgement and nothing seen"
    fi
  fi
fi

say; say "== Summary"; for r in "${ROWS[@]}"; do say "  $r"; done
say; say "Power at end: $(vcgencmd get_throttled)    Log: $LOG"
