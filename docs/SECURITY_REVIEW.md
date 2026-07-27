# Security Review — v0.1.0

Scope: the agent runtime, platform adapters and app hosts as of the v0.1.0 tag.
This is a self-review of the security-relevant surfaces. It is not a substitute
for an external audit before shipping on consumer devices.

## Threat model in one line

An LLM (possibly influenced by on-screen content) can request **tool calls that
control a TV**. The security goal is: the blast radius stays limited to
non-destructive TV control, and no code execution, secret exposure, or data
exfiltration is possible through the agent.

## Surfaces & findings

| # | Surface | Risk | Status / mitigation |
|---|---------|------|---------------------|
| 1 | Tool execution from LLM output | Model calls a tool with bad/hostile args | **Mitigated.** `validateArgs` enforces types, coercion and `enum`s before execution; unknown tools throw `UnknownToolError`; tools only wrap the HAL — no `eval`, shell, filesystem or arbitrary network. `maxIterations` caps tool rounds; `turnTimeoutMs` bounds wall-clock. |
| 2 | Prompt injection (app names, titles → context) | On-screen text steers the model to call tools | **Contained.** Tool surface is TV control only (volume/apps/nav/media); no destructive or data-access tools exist. Recommend confirmation for high-impact actions once privileged signing is added (standby, input switch). |
| 3 | Android `addJavascriptInterface` bridge | Web content calls native `TvNativeBridge` | **Mitigated by design.** The WebView loads only the **bundled local assets** (`file:///android_asset/index.html`); no remote origin is loaded. Bridge methods are minimal and non-destructive (volume/app/kv). Only `@JavascriptInterface`-annotated methods are exposed (safe on API 17+). |
| 4 | WebView configuration (AOSP) | Over-permissive WebView | **Hardening recommended** (see below): keep file access from file URLs disabled, add a CSP meta to the app HTML, and never load untrusted URLs. |
| 5 | LLM endpoint / data routing | Conversation sent off-device to a cloud endpoint | **Operator-controlled.** Default is loopback (`127.0.0.1`); base URL and API key are configuration, never hardcoded. Routing policy documented in `docs/on-device-inference.md`. Base URL is set at deploy time, not attacker-controllable at runtime. |
| 6 | Secrets in repo | Leaked keys/keystores | **None present.** `.gitignore` excludes `.env*`, `*.keystore`, `*.p12`, `signing/`. API keys are runtime config. |
| 7 | Supply chain | Malicious/incompatible dependency | **Mitigated.** `pnpm license:check` (in CI) blocks strong-copyleft/non-commercial; `pnpm sbom` emits a CycloneDX SBOM; Dependabot watches npm + actions. Core has zero runtime deps beyond workspace packages. |
| 8 | Persistent storage | Sensitive data at rest | **Low.** `KeyValueStore` is in-memory (web/tizen) or bridge-backed; nothing sensitive is persisted by default. |
| 9 | Accessibility service (AOSP) | Elevated navigation capability | **User-gated.** Requires explicit enablement in Settings; performs only global actions + focus navigation, not raw key injection. |
| 10 | webOS Luna calls | Unexpected service invocation | **Bounded.** Fixed service URIs; parameters originate from validated tool args; partner/platform APIs are not called on unprivileged builds. |

## Recommended hardening

- **AOSP WebView:** ✅ implemented — `MainActivity` disables
  `allowFileAccessFromFileURLs`, `allowUniversalAccessFromFileURLs`,
  `allowFileAccess` and `allowContentAccess`, and `shouldOverrideUrlLoading`
  keeps navigation inside `file:///android_asset/`. A restrictive
  `Content-Security-Policy` `<meta>` is set in every app `index.html`
  (`object-src 'none'`, `base-uri 'none'`, `frame-src 'none'`, loopback+https
  `connect-src`). *Validate the CSP on each target engine* — `file://`/app-scheme
  origin semantics vary across Android WebView / Tizen / webOS.
- **Confirmation gate:** ✅ implemented — `ToolSpec.confirm` + `AgentOptions.confirm`
  gate high-impact tools; `set_input_source` and `launch_app` are confirm-required
  by default. Wire a real confirm UI on privileged builds.
- **Bridge allowlist:** keep the native bridge surface minimal; review every new
  `@JavascriptInterface` method for abuse potential.
- **Dependency review:** run the license gate and SBOM on every release; triage
  Dependabot PRs promptly.

## Conclusion

No high-severity issues found in the current scaffold. The architecture keeps the
agent's blast radius limited to TV control, validates all model-proposed tool
arguments, and ships no secrets. The items above are defense-in-depth
improvements to complete before first-party production deployment.
