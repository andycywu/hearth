#!/bin/bash
# Record the three spoken commands the self-test plays into the voice path, in your own voice.
#
#     bash tools/pi-record-voice.sh                 # into ~/hearth-voice
#     bash tools/pi-record-voice.sh /some/dir
#
# Why: espeak-ng is the only voice a Pi has, and the offline model cannot read it (2026-10-14:
# "hearth, turn off the tv" came back as "经历"). A self-test that plays a robot into the recogniser
# can only fail, and says nothing about a person. Your voice, recorded once, makes the same test
# deterministic and meaningful: pi-selftest.sh uses these files whenever they exist.
#
# Say each phrase at the volume and distance you would use to a television. The recordings stay on
# this machine; nothing is uploaded. Each is kept only if it is clearly louder than the room.
set -u
DIR="${1:-$HOME/hearth-voice}"
DEV="${HEARTH_AUDIO_DEVICE:-default}"
mkdir -p "$DIR"
level() { ffmpeg -hide_banner -nostats -i "$1" -af volumedetect -f null - 2>&1 | awk '/mean_volume/ {print $5}'; }

echo "Recording to $DIR from '$DEV'. Stay silent for 3 seconds first..."
arecord -D "$DEV" -f S16_LE -r 16000 -c 1 -d 3 -q "$DIR/_room.wav" || { echo "arecord failed — is the microphone plugged in?"; exit 1; }
room=$(level "$DIR/_room.wav")
echo "Room level: ${room} dB (mean)."

rec() { # file phrase
  local f="$DIR/$1.wav" try=0
  while [ $try -lt 3 ]; do
    try=$((try+1))
    read -r -p "  Press Enter, wait for the beep, then say:  \"$2\"  " _
    espeak-ng "beep" 2>/dev/null
    arecord -D "$DEV" -f S16_LE -r 16000 -c 1 -d 4 -q "$f" || return 1
    m=$(level "$f")
    # Speech should sit well above the room. 10 dB is a low bar; a spoken sentence usually clears it by 20+.
    if awk -v a="${m:--99}" -v b="${room:--99}" 'BEGIN { exit !(a - b >= 10) }'; then
      echo "    ok: ${m} dB mean (room ${room} dB)"; return 0
    fi
    echo "    too quiet: ${m} dB mean vs room ${room} dB — nothing was heard. Closer, louder, and say it right after the beep."
  done
  echo "    giving up on $1 after 3 tries"; return 1
}

ok=1
rec turn-off-the-tv "hearth, turn off the tv" || ok=0
rec turn-on-the-tv  "hearth, turn on the tv"  || ok=0
rec turn-it-down    "hearth, turn it down"    || ok=0
rm -f "$DIR/_room.wav"

if [ $ok = 1 ]; then
  read -r -p "Play them back through the television to check they are you? [y/n] " a
  if [[ "$a" =~ ^[Yy] ]]; then for f in turn-off-the-tv turn-on-the-tv turn-it-down; do aplay -q "$DIR/$f.wav"; done; fi
  echo "Done. Now:  bash tools/pi-selftest.sh --tv-power"
else
  echo "Some recordings failed; re-run this script."; exit 1
fi
