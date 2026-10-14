#!/bin/bash
# Everything on the Pi that can be checked without a person standing in the room.
#
#   bash tools/pi-selftest.sh              read-only checks, plus quiet changes it puts back (volume)
#   bash tools/pi-selftest.sh --tv-power   also puts the television in STANDBY and wakes it (twice)
#
# Run it on the Pi. Each line says how the result is known, because "OK" about something nobody read
# back is what this repo exists to refuse:
#   VERIFIED     a machine read the result back (a sink volume, the TV's own power state, a transcript)
#   UNVERIFIED   it was done and nothing can read it back
#   UNSUPPORTED  the other side said it cannot
#   FAILED       it was tried and did not work
#   NEEDS-PERSON what only an ear, an eye or a voice in the room can settle — listed, never guessed
#
# The voice test is end to end but not acoustic: speech is played into the whole path — the recogniser,
# the wake word, the agent, the CEC bus and the speaker — as if it were the microphone
# (HEARTH_AUDIO_DEVICE=file:...). That tests everything after the air. It does not test the air.
#
# Which speech matters. espeak-ng is what a Pi has, and the small bilingual model cannot read it: on
# 2026-10-14 it turned "hearth, turn off the tv" into "经历". So a failure on synthetic speech says
# nothing about a person. Put real recordings (16 kHz mono 16-bit WAV, made with tools/pi-record-voice.sh)
# in $HEARTH_VOICE_FIXTURES — turn-off-the-tv.wav, turn-on-the-tv.wav, turn-it-down.wav — and those are
# used instead, and the verdict is about a human voice.
set -u
TVPOWER=0; [ "${1:-}" = "--tv-power" ] && TVPOWER=1
CLI="${HEARTH_CLI:-$HOME/hearth/apps/cli/dist/main.js}"
CEC=${HEARTH_CEC_DEV:-/dev/cec0}
export PATH="$HOME/.local/node/bin:$PATH"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
H="node $CLI --platform linux"
# Quiet and short-lived: no voice from the saved config, no ring (it draws current), no model call.
export HEARTH_VOICE=0 HEARTH_LEDS=0

declare -a ROWS
row() { ROWS+=("$(printf '%-12s %-44s %s' "$1" "$2" "$3")"); echo "  -> $1: $2 — $3"; }
sec() { echo; echo "== $*"; }
tvpower() { cec-ctl -d "$CEC" --to 0 --give-device-power-status 2>&1 | awk '/pwr-state/ {print $2}'; }
sink() { wpctl get-volume @DEFAULT_AUDIO_SINK@ | awk '{print $2}'; }
level() { ffmpeg -hide_banner -nostats -i "$1" -af volumedetect -f null - 2>&1 | awk '/mean_volume/ {m=$5} /max_volume/ {x=$5} END {print m, x}'; }
claimed() { cec-ctl -d "$CEC" 2>&1 | grep -q 'Logical Addresses *: [1-9]'; }

echo "Hearth self-test  $(date)   tv-power: $([ $TVPOWER = 1 ] && echo yes || echo no)"
orig=$(sink)

sec "0. The box"
thr=$(vcgencmd get_throttled | cut -d= -f2)
[ "$thr" = "0x0" ] && row VERIFIED "power: get_throttled" "$thr" || row UNVERIFIED "power: get_throttled" "$thr — timings and levels below are less trustworthy"
[ -f "$CLI" ] && row VERIFIED "hearth CLI is built" "$CLI" || { row FAILED "hearth CLI is built" "$CLI missing"; exit 1; }

sec "1. Audio out (the HDMI sink)"
wpctl set-volume @DEFAULT_AUDIO_SINK@ 0.40; sleep 0.4
[ "$(sink)" = "0.40" ] && row VERIFIED "sink volume write + read-back" "set 0.40, read $(sink)" || row FAILED "sink volume write + read-back" "set 0.40, read $(sink)"
out=$($H --yes "set volume to 55" 2>&1 < /dev/null | tail -1); sleep 0.4
[ "$(sink)" = "0.55" ] && row VERIFIED "hearth \"set volume to 55\" -> the sink" "$out; sink reads $(sink)" || row FAILED "hearth \"set volume to 55\"" "sink reads $(sink); said: $out"
$H --yes "turn it down" >/dev/null 2>&1 < /dev/null; sleep 0.4
awk -v v="$(sink)" 'BEGIN { exit !(v < 0.55) }' && row VERIFIED "hearth \"turn it down\" lowers the sink" "0.55 -> $(sink)" || row FAILED "hearth \"turn it down\"" "sink still $(sink)"
$H --yes "mute" >/dev/null 2>&1 < /dev/null; sleep 0.3
wpctl get-volume @DEFAULT_AUDIO_SINK@ | grep -q MUTED && row VERIFIED "hearth \"mute\" mutes the sink" "[MUTED] read back" || row FAILED "hearth \"mute\"" "not muted"
$H --yes "unmute" >/dev/null 2>&1 < /dev/null; sleep 0.3
wpctl get-volume @DEFAULT_AUDIO_SINK@ | grep -q MUTED && row FAILED "hearth \"unmute\"" "still muted" || row VERIFIED "hearth \"unmute\" unmutes the sink" "[MUTED] gone"
wpctl set-volume @DEFAULT_AUDIO_SINK@ "$orig"
espeak-ng "Hearth self test." 2>/dev/null && row NEEDS-PERSON "speech audible from the TV speakers" "espeak-ng ran; only an ear can say it was heard"

sec "2. Audio in (the ReSpeaker)"
arecord -D default -f S16_LE -r 16000 -c 1 -d 3 -q "$WORK/room.wav" 2>/dev/null
if [ -s "$WORK/room.wav" ]; then
  read -r roomm roomx < <(level "$WORK/room.wav")
  row VERIFIED "microphone captures" "room: ${roomm} dB mean, ${roomx} dB peak"
else row FAILED "microphone captures" "arecord wrote nothing"; fi
wpctl set-volume @DEFAULT_AUDIO_SINK@ 0.8
arecord -D default -f S16_LE -r 16000 -c 1 -d 4 -q "$WORK/loop.wav" 2>/dev/null & rec=$!
sleep 0.5; espeak-ng -s 130 "Hearth, turn it down. Hearth, turn it down." 2>/dev/null; wait $rec
wpctl set-volume @DEFAULT_AUDIO_SINK@ "$orig"
read -r lm lx < <(level "$WORK/loop.wav")
gain=$(awk -v a="${lm:--99}" -v b="${roomm:--99}" 'BEGIN { printf "%.1f", a - b }')
if awk -v g="$gain" 'BEGIN { exit !(g >= 6) }'; then
  row VERIFIED "the microphone hears the TV speakers" "${lm} dB vs ${roomm} dB quiet (+${gain} dB): speaker -> air -> mic works"
else
  row UNVERIFIED "the microphone hears the TV speakers" "${lm} dB vs ${roomm} dB quiet (+${gain} dB): too faint to test the acoustic path with the speaker"
fi
row NEEDS-PERSON "a human voice is captured and transcribed" "needs someone to speak to the microphone: hearth-io-test.sh step 4, or the Lab's Audio tab"

sec "3. HDMI-CEC"
$H cec diagnose > "$WORK/diag.txt" 2>&1; code=$?
if [ $code = 0 ]; then row VERIFIED "hearth cec diagnose" "every layer from the cable to the TV works"; else row FAILED "hearth cec diagnose" "$(grep -m1 '✗' "$WORK/diag.txt" || head -1 "$WORK/diag.txt")"; fi
claimed && row VERIFIED "CEC adapter has a logical address" "$(cec-ctl -d $CEC 2>&1 | grep -m1 'Logical Addresses *:' | sed 's/^[[:space:]]*//')" || row FAILED "CEC adapter has a logical address" "unconfigured"
p=$(tvpower)
[ -n "$p" ] && row VERIFIED "the TV answers its power state" "'$p'" || row FAILED "the TV answers its power state" "no reply"
aud=$(cec-ctl -d "$CEC" --to 0 --give-audio-status 2>&1)
echo "$aud" | grep -q FEATURE_ABORT && row UNSUPPORTED "the TV reports its volume over CEC" "Feature Abort: a volume key can be sent, never read back"
if [ $TVPOWER = 1 ]; then
  $H cec tv-standby --yes > "$WORK/sb.txt" 2>&1
  grep -q "VERIFIED" "$WORK/sb.txt" && row VERIFIED "hearth cec tv-standby" "the TV reported standby" || row FAILED "hearth cec tv-standby" "$(grep -m1 'read-back' "$WORK/sb.txt")"
  $H cec tv-wake-image --yes > "$WORK/wk.txt" 2>&1
  grep -q "VERIFIED" "$WORK/wk.txt" && row VERIFIED "hearth cec tv-wake-image" "the TV reported on" || row FAILED "hearth cec tv-wake-image" "$(grep -m1 'read-back' "$WORK/wk.txt")"
  sleep 3

  # The agent itself, by typed sentence: plan, CEC, read-back, and the TV's own state as ground truth.
  out=$($H --yes "turn off the tv" 2>/dev/null < /dev/null | tail -1); sleep 2; p=$(tvpower)
  [ "$p" = "standby" ] && row VERIFIED "hearth \"turn off the tv\"" "TV reads standby; hearth said: $out" || row FAILED "hearth \"turn off the tv\"" "TV reads '$p'; hearth said: $out"
  out=$($H --yes "turn on the tv" 2>/dev/null < /dev/null | tail -1); sleep 2; p=$(tvpower)
  [ "$p" = "on" ] && row VERIFIED "hearth \"turn on the tv\"" "TV reads on; hearth said: $out" || row FAILED "hearth \"turn on the tv\"" "TV reads '$p'; hearth said: $out"
  sleep 4
else
  row SKIPPED "TV standby / wake over CEC" "not run: pass --tv-power (it switches the television off for a few seconds)"
fi
row NEEDS-PERSON "the TV picture went dark and came back" "only an eye can say; the TV's own power state is what was read back"
row NEEDS-PERSON "a CEC volume key moved the TV's volume" "no acknowledgement exists; only the on-screen indicator can say"

sec "4. The recogniser, on synthetic speech"
if [ -n "${HEARTH_STT_MODEL_PATH:-}" ] && [ -n "${HEARTH_STT_RUNTIME_PATH:-}" ]; then
  mkdir -p "$WORK/rec"
  mk() { espeak-ng -v en-us -s 135 -w "$WORK/raw.wav" "$2" 2>/dev/null; ffmpeg -loglevel error -y -i "$WORK/raw.wav" -ar 16000 -ac 1 -sample_fmt s16 "$WORK/rec/$1.wav"; }
  mk a "hearth, turn it down"; mk b "hearth, turn off the tv"; mk c "hearth, turn on the tv"; mk d "set volume to twenty"
  cat > "$WORK/m.json" <<'JSON'
{ "items": [
 {"id":"a","audio":"rec/a.wav","expected":"hearth turn it down"},
 {"id":"b","audio":"rec/b.wav","expected":"hearth turn off the tv"},
 {"id":"c","audio":"rec/c.wav","expected":"hearth turn on the tv"},
 {"id":"d","audio":"rec/d.wav","expected":"set volume to twenty"} ] }
JSON
  node "$CLI" stt bench "$WORK/m.json" --realtime --quiet > "$WORK/bench.json" 2>"$WORK/bench.err"
  if [ -s "$WORK/bench.json" ]; then
    node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); for (const x of r.results) console.log("     "+x.id+": heard "+JSON.stringify(x.actual)+"  (error rate "+(x.cer==null?"-":x.cer.toFixed(2))+", "+x.finalLatencyMs+" ms after the end)"); console.log("     summary: "+JSON.stringify({meanCer:r.summary.meanCer,p95:r.summary.finalLatencyP95Ms,rss:r.summary.maxEngineRssMb}))' "$WORK/bench.json"
    cer=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(r.summary.meanCer)' "$WORK/bench.json")
    if awk -v c="$cer" 'BEGIN { exit !(c < 0.5) }'; then row VERIFIED "the recogniser transcribes synthetic speech" "mean error rate $cer; a robot voice is not a person, so this is a floor, not a score"
    else row UNVERIFIED "the recogniser on synthetic speech" "it ran (latency above is real) but cannot read espeak-ng: mean error rate $cer — nothing here is about a human voice"; fi
  else row FAILED "the recogniser runs" "$(tail -2 "$WORK/bench.err")"; fi
else
  row SKIPPED "the recogniser" "set HEARTH_STT_MODEL_PATH and HEARTH_STT_RUNTIME_PATH"
fi

sec "5. The whole voice path: speech -> recogniser -> wake word -> agent -> CEC / sink -> reply"
if [ -n "${HEARTH_STT_MODEL_PATH:-}" ] && [ -n "${HEARTH_STT_RUNTIME_PATH:-}" ] && [ $TVPOWER = 1 ]; then
  sil() { ffmpeg -loglevel error -y -f lavfi -i "anullsrc=r=16000:cl=mono" -t "$1" -sample_fmt s16 "$WORK/rec/sil$1.wav"; }
  FIX="${HEARTH_VOICE_FIXTURES:-$HOME/hearth-voice}"
  if [ -f "$FIX/turn-off-the-tv.wav" ] && [ -f "$FIX/turn-on-the-tv.wav" ] && [ -f "$FIX/turn-it-down.wav" ]; then
    SPEECH="a human voice (recorded in $FIX)"
    for pair in "u1 turn-off-the-tv" "u2 turn-on-the-tv" "u3 turn-it-down"; do set -- $pair
      ffmpeg -loglevel error -y -i "$FIX/$2.wav" -ar 16000 -ac 1 -sample_fmt s16 "$WORK/rec/$1.wav"; done
  else
    SPEECH="SYNTHETIC speech (espeak-ng) — a failure here says nothing about a person"
    mk u1 "hearth, turn off the tv"; mk u2 "hearth, turn on the tv"; mk u3 "hearth, turn it down"
  fi
  echo "     speech used: $SPEECH"
  sil 2; sil 16
  : > "$WORK/list.txt"
  for part in sil2 u1 sil16 u2 sil16 u3 sil16; do echo "file '$WORK/rec/$part.wav'" >> "$WORK/list.txt"; done
  ffmpeg -loglevel error -y -f concat -safe 0 -i "$WORK/list.txt" -c copy "$WORK/session.wav"
  wpctl set-volume @DEFAULT_AUDIO_SINK@ 0.60
  ( while :; do echo "$(date +%s) $(tvpower)"; sleep 1; done ) > "$WORK/tv.log" 2>&1 & poll=$!
  # --serve with no stdin: stay up until timeout ends it. The file is the microphone.
  HEARTH_AUDIO_DEVICE="file:$WORK/session.wav" timeout -s TERM 120 $H --voice --asr local --wake hearth --serve > "$WORK/voice.log" 2>&1 < /dev/null
  kill $poll 2>/dev/null; wait $poll 2>/dev/null
  vol_after=$(sink); wpctl set-volume @DEFAULT_AUDIO_SINK@ "$orig"
  echo "     what it heard and did:"; grep -E '🎤|· |Done|TV|tv|stopped|error' "$WORK/voice.log" | grep -v '"event"' | sed 's/^/       /' | head -30
  heard=$(grep -c '🎤' "$WORK/voice.log")
  saw_standby=$(grep -c ' standby$' "$WORK/tv.log"); last=$(tail -1 "$WORK/tv.log" | awk '{print $2}')
  if grep -q -E '🎤 [^(]' "$WORK/voice.log"; then row VERIFIED "wake word + command recognised from speech ($SPEECH)" "$(grep -c -E '🎤 [^(]' "$WORK/voice.log") line(s) passed the wake word and reached the agent"
  else row FAILED "wake word + command recognised from speech" "nothing passed the wake word ($SPEECH); see the 'not for me' lines above for what was heard"; fi
  [ "$saw_standby" -gt 0 ] && row VERIFIED "spoken \"turn off the tv\" -> TV standby (read from the TV)" "TV reported standby $saw_standby time(s) in the poll" || row FAILED "spoken \"turn off the tv\" -> TV standby" "the TV never reported standby"
  # "on at the end" proves nothing if it never went off: credit the wake only after a standby was seen.
  if [ "$saw_standby" -eq 0 ]; then row UNVERIFIED "spoken \"turn on the tv\" -> TV on" "not tested: the TV was never switched off first, so \"on at the end\" says nothing"
  elif [ "$last" = "on" ]; then row VERIFIED "spoken \"turn on the tv\" -> TV on (read from the TV)" "TV reads on at the end, after standby"
  else row FAILED "spoken \"turn on the tv\" -> TV on" "TV reads '$last' at the end"; fi
  awk -v v="$vol_after" 'BEGIN { exit !(v < 0.60) }' && row VERIFIED "spoken \"turn it down\" -> the sink" "0.60 -> $vol_after" || row FAILED "spoken \"turn it down\" -> the sink" "sink read $vol_after (started 0.60)"
  [ "$(tvpower)" = "on" ] || { cec-ctl -d "$CEC" --to 0 --image-view-on >/dev/null 2>&1; echo "     (put the TV back on)"; }
else
  row SKIPPED "the whole voice path" "needs --tv-power and the HEARTH_STT_* paths (it switches the TV off and on)"
fi
row NEEDS-PERSON "the spoken reply is heard and understood" "espeak-ng speaks it; only an ear can say"

sec "Summary"
for r in "${ROWS[@]}"; do echo "  $r"; done
echo; echo "power at end: $(vcgencmd get_throttled)   TV: $(tvpower)   sink: $(sink)"
fails=$(printf '%s\n' "${ROWS[@]}" | grep -c '^FAILED')
echo "$fails FAILED"
[ "$fails" = 0 ]
