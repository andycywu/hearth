# Device reports

One file per television, generated rather than written:

```bash
node tools/device-report.mjs            # Android TV / AOSP, over adb
```

Each file is a **Hearth Report section**, already formatted — the intended use is
to paste it into an issue, or open a PR that adds it to
[`../capability-matrix.md`](../capability-matrix.md).

The formatting happens on the device, by the same code every host ships
(`exposeDeviceReport`), so a report taken by hand from a browser console is
identical to one taken by the tool. If your platform has no adb, open the app,
then in the WebView console:

```js
(await window.__hearthReport({ allowWrites: true })).markdown
```

## What makes a report worth having

- **The exact model and firmware.** "Android TV" is not a device.
- **What the device *did*, not what it returned.** The section headed *"Did
  anything accept a command and then do nothing?"* is the one no adapter can
  answer about itself, and the reason the whole verification loop exists.
- **Failures.** "It would not install, here is the error" is a result. So is a
  capability that has never worked on any firmware you have tried.

A report from an emulator is worth less than one from a retail TV, and both are
worth more than the guess they replace. The emulator report in this directory is
kept as an example of the shape, and is labelled as one.
