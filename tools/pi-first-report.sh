#!/usr/bin/env bash
# First real-device Hearth Report from a Pi beside the TV. Run ON the Pi, in the
# repo:   bash tools/pi-first-report.sh
# Everything it learns goes to docs/platform/reports/pi-first-report.log so the
# whole run can be read afterwards, and the report itself to
# docs/platform/reports/pi3b-<tv>.md — set HEARTH_TV=titanos-mt9620 (or whatever
# the television is) so two living rooms do not overwrite each other.
set -u
cd "$(dirname "$0")/.." || exit 1
OUT=docs/platform/reports/pi3b-${HEARTH_TV:-tv}.md
LOG=docs/platform/reports/pi-first-report.log
exec > >(tee "$LOG") 2>&1

say() { printf '\n== %s\n' "$*"; }

# A non-interactive ssh reads neither .profile nor .bashrc, and that is where
# a hand-installed Node gets its PATH on a Pi. Worth knowing: a systemd unit
# starts from the same empty PATH, so the install step will have to pin this.
if ! command -v node >/dev/null; then
  [ -d "$HOME/.local/node/bin" ] && export PATH="$HOME/.local/node/bin:$PATH"
  [ -d "$HOME/.local/bin" ] && export PATH="$HOME/.local/bin:$PATH"
  if ! command -v node >/dev/null && [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"; nvm use --silent 26 >/dev/null 2>&1 || nvm use --silent default >/dev/null 2>&1
  fi
  command -v node >/dev/null && echo "(node found at $(command -v node) — not on the non-interactive PATH; a service unit will need it pinned)"
fi

say "0. what this box is"
cat /proc/device-tree/model 2>/dev/null | tr -d '\0'; echo
grep PRETTY_NAME /etc/os-release; uname -r
echo "node: $(node -v 2>&1)   pnpm: $(pnpm -v 2>&1)"
echo "cec-ctl: $(command -v cec-ctl || echo MISSING)"; ls -l /dev/cec0 2>&1
id -nG | tr ' ' '\n' | grep -qx video && echo "in video group: yes" || echo "in video group: NO"
echo "audio tools: wpctl=$(command -v wpctl || echo -) pactl=$(command -v pactl || echo -) amixer=$(command -v amixer || echo -)"
echo "voice tools: arecord=$(command -v arecord || echo -) espeak-ng=$(command -v espeak-ng || echo -)"

NODE_MAJOR=$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 26 ]; then
  echo "!! Node >= 26 required (.nvmrc). Stop here and install it (nvm install 26 && nvm use 26)."; exit 2
fi

say "1. sync and build"
git pull --ff-only && git log --oneline -1 || exit 3
pnpm install --frozen-lockfile || exit 3
pnpm build || exit 3

say "2. the bus, raw (what cec-ctl itself says)"
if command -v cec-ctl >/dev/null; then
  timeout 20 cec-ctl -d /dev/cec0 --playback -S 2>&1 | head -40
else
  echo "no cec-ctl; skipping"
fi

say "3. dry run — read-only, one scenario, nothing changes"
node apps/cli/dist/main.js --platform linux report --intents "turn it down" 2>&1 | head -60

say "4. the real one — gated steps approved, volume round-trip allowed, demo room"
node apps/cli/dist/main.js --platform linux report --yes --writes --room demo --out "$OUT"
echo "exit=$?"

say "5. result"
head -5 "$OUT" 2>/dev/null
echo
echo "Done. Copy both files to your PC's repo folder, e.g. from Windows:"
echo "  tools/pi.ps1 does this; by hand it is two scp calls for $OUT and $LOG"
