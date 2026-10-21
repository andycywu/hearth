# Tizen input probe

A throwaway page that asks a Tizen television what it will tell a web app about its inputs, and — only when told to — switches them.
Not part of the Hearth runtime. It exists to turn a claim in `docs/platform/capability-matrix.md` into a measurement.

```sh
sdb connect <tv-ip>:26101                                   # the TV's Developer mode must list this PC as its Host PC IP
node tools/experiments/tizen-input-probe/run.mjs --profile tizen-dev                       # reads only
node tools/experiments/tizen-input-probe/run.mjs --profile tizen-dev --switch HDMI:3,HDMI:1 --yes-switch
```

`--switch` takes a comma list and puts the television back on whatever it was showing at the start. It needs `--yes-switch` as well,
because it changes the picture. The signing profile is part of the question: run it once per profile you have (`tizen-dev`, a Samsung
certificate) and keep both results.

Each run writes `results/<profile>-<time>.json`: what the television **answered**, including the name, message and code of any refusal.
The first run of this probe also taught us two signatures the hard way (`tvwindow.getSource` takes the window type, not callbacks; the
television said so in a `TypeMismatchError`), which is why the failed calls are kept in `results/` rather than tidied away.

The result so far, and what it changed, is in [`docs/platform/free-my-tv-reference.md`](../../../docs/platform/free-my-tv-reference.md).
