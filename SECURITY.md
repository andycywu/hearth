# Security Policy

## Reporting a vulnerability
Please report security issues privately to the maintainers (do not open a public
issue). We aim to acknowledge within a few business days.

## Scope notes
- The agent can control TV hardware via the HAL. Treat tool execution as a
  privileged surface: validate LLM-proposed tool arguments (the core validates
  against tool schemas) and keep the native bridge's exposed methods minimal.
- On-device inference is preferred for privacy-sensitive commands; document any
  data sent to a cloud LLM endpoint.
