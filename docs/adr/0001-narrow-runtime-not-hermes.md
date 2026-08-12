# ADR 0001: Boomer Buddy uses a narrow runtime, not Hermes

- Status: Accepted
- Date: 2026-08-11
- Scope: Runtime Boundary v0

## Context

Boomer Buddy is an elder-facing, patron-controlled assistant. A general agent workbench such as Hermes is optimized for developer or controlled-household operation and can expose broad primitives, dynamic tools, or developer-oriented approvals. Those are the wrong authority and interaction boundaries for this product.

The eventual Expo client still needs a standard, model-agnostic streaming protocol. AG-UI supplies that client/runtime protocol without requiring CopilotKit, a specific model, or a general agent runtime.

## Decision

Boomer Buddy owns a narrow server-side runtime with these layers:

1. A replaceable model provider may propose only a capability identifier and arguments.
2. A fixed registry decides whether the capability exists and validates its arguments and output.
3. Server policy decides whether approval is required and whether patron scope matches.
4. Mutations execute only after a valid semantic approval resume; model output alone is never mutation authority.
5. A closed component registry emits only schema-validated component keys and props.
6. Safe, structured receipts and patron state remain outside the provider.
7. An AG-UI adapter validates standard lifecycle, message, tool, state, interrupt, and resume events with `@ag-ui/core` 0.0.57. Boomer Buddy structured UI uses the standard `CUSTOM` event with the namespaced `boomer_buddy.ui` value.

Hermes may still be used elsewhere as a developer workbench or separately controlled household agent. It is not linked into the product runtime and is not part of this repository slice.

## Consequences

The runtime is less flexible by design. Adding a capability requires an explicit manifest, schemas, patron scope, approval policy, executor, receipt behavior, UI allowlist, and tests. This makes new authority visible and reviewable.

The v0 adapters are in memory and are not an HTTP service. A later transport can serialize the already-validated AG-UI events without moving domain policy into the client or model provider.

## Rejected alternatives

- Exposing Hermes directly: rejects the elder-facing security and approval model.
- Letting the model define tools or UI code: grants unreviewed authority and executable presentation.
- Coupling the domain to CopilotKit or Expo: makes core policy depend on one client library.
- Adding a database or full authentication service in v0: expands scope before the contract is proven.

## Specification references

- AG-UI event lifecycle: https://docs.ag-ui.com/concepts/events
- AG-UI tool lifecycle: https://docs.ag-ui.com/concepts/tools
- AG-UI JavaScript event schemas: https://docs.ag-ui.com/sdk/js/core/events
