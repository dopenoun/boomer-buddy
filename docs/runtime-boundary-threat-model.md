# Boomer Buddy Runtime Boundary v0: capabilities and threat model

## System boundary

The patron/client sends a patron-scoped request. A production adapter must authenticate the caller and derive that scope server-side; v0 itself accepts scope as an input and is not an identity boundary. The model provider can propose an action, but the server-owned registry, schemas, scope checks, approval state machine, and executor make every action-dispatch decision. The runtime returns validated AG-UI events. Receipts and state are stored outside the provider.

This slice has no terminal, shell, generic filesystem operation, arbitrary URL fetch, general network client, arbitrary MCP call, generated code execution, or dynamic tool registration. `scripts/authority-lint.mjs` discovers every runtime TypeScript file, allows only the declared external modules, and rejects dynamic/general-purpose execution or network primitives. An injected `ModelProvider` is still in-process application code; v0 constrains its returned data, not side effects performed inside the provider implementation.

## Executable capability manifests

| Capability | Version | Purpose | Class | Approval | Patron scope | Receipt | UI |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `search_help_catalog` | 0.1.0 | Search reviewed local help | Read-only | None | Required | Scope, provenance digest, outcome, timestamp | `GuideCard` |
| `create_reminder` | 0.1.0 | Create one reminder | Mutating | Semantic confirmation | Required | Scope, provenance digest, approval, outcome, timestamp | `ReminderConfirmationCard`, `ActionReceiptCard`, `SafetyNoticeCard` |

Each manifest contains strict input and output schemas. `create_reminder` is idempotent by tenant, patron, and action ID. It cannot execute until the associated patron-scoped interrupt is resumed with an exact validated approval decision. The confirmation component is validated before pending state is saved. Rejection, cancellation, timeout, disconnection, scope failure, invalid arguments, an unsafe confirmation, or an unregistered capability produce no mutation.

## Intended catalog, not executable in v0

The intended narrow catalog is `search_help_catalog`, `read_patron_note`, `create_reminder`, `list_reminders`, `request_vault_unlock`, `read_unlocked_vault_item`, `save_patron_preference`, and `contact_trusted_helper`.

Only the two capabilities in the executable table are registered. Planned names are metadata, not callable stubs. There is no generic escape hatch.

## Closed generative UI

Allowed components are:

- `GuideCard`
- `ReminderConfirmationCard`
- `ActionReceiptCard`
- `SafetyNoticeCard`

The runtime emits `{ schemaVersion, component: { key, props } }` inside the standard AG-UI `CUSTOM` event named `boomer_buddy.ui`. It rejects unknown/prototype keys, unknown props, event-handler-like props, HTML/JSX/script-like content, malformed props, malformed custom events, state paths or values outside the closed runtime state schema, and component payloads over 16 KiB. Policy registries and manifests are frozen. It never emits JavaScript, JSX, HTML, or arbitrary component source.

## AG-UI subset

Runtime Boundary v0 uses official event names and schemas for:

- `RUN_STARTED`, `RUN_FINISHED`, and `RUN_ERROR`
- `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, and `TEXT_MESSAGE_END`
- `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, and `TOOL_CALL_RESULT`
- `STATE_SNAPSHOT` and RFC 6902 `STATE_DELTA`
- interrupt-aware `RUN_FINISHED.outcome`
- resume as a new run linked with `parentRunId`
- `CUSTOM` only for the namespaced, closed structured-UI envelope

The domain has no CopilotKit or frontend-library dependency.

## Face ID and vault contract

Biometric verification belongs to native device UI. The backend receives no face image, template, sensor result, passcode, or other biometric material. A trusted native/authentication boundary may provide only an opaque `verifiedGrantId`, patron ID, capability ID, and near-term expiry.

The test authorization service:

- accepts only that strict grant shape;
- caps authorization lifetime at two minutes;
- scopes authorization to one patron and one capability;
- rejects expired grants, grant replay, authorization replay, and scope mismatch;
- marks authorization used on its first successful consumption.

This contract does not claim production attestation, authentication, secure hardware integration, or vault storage.

## Provenance and receipts

Every run and proposed/executed action receives structured IDs for tenant, patron, thread, run, action, capability, capability version, and receipt. The runtime includes UUID-backed IDs for non-test use and deterministic sequential IDs for tests. Receipts include model-provider ID, approval state, execution outcome, timestamp, safe error code, message ID, and a SHA-256 content digest. They do not store raw patron messages, reminder content, secrets, biometric data, vault grants, or tokens.

The v0 store is process-local. The identifiers and receipt schema are stable contract examples; persistence and atomic idempotency across restarts or multiple processes are required production follow-ups. Receipt errors use canonical server-owned messages/codes so provider-controlled error text is not emitted or stored.

## Threats and controls

| Threat | Server-side control | Deterministic evidence |
| --- | --- | --- |
| Model selects shell, network, filesystem, or MCP | Exact two-entry executable registry; authority lint | Unregistered-tool and registry tests |
| Model smuggles extra arguments | Strict Zod input schemas | Argument-violation test |
| Model output mutates state | Pending interrupt plus explicit resume required | Pause, approve, reject, cancel, timeout tests |
| Duplicate approval repeats mutation | Action-ID idempotency and finalized state | Duplicate-resume test |
| Patron reads or resumes another patron's action | Tenant/thread owner and patron checks | Cross-patron test |
| Model injects executable UI | Closed key/prop schemas, dangerous-content scan, size cap | Component injection tests |
| Client sends malformed protocol data | Official AG-UI schemas plus strict local custom/state validation | Malformed-event tests |
| Client disconnect races a mutation | Connection check before proposal and immediately before mutation; pending action remains resumable | Disconnect/reconnect tests |
| Vault grant or authorization is replayed | Single-use, expiry, patron and capability scope | Vault tests |
| Receipts leak private content | Explicit receipt projection, hashes, sensitive-key/value guard | Leakage test |

## Known limitations

- There is no authenticated transport. Exact tenant/patron/thread identifiers and interrupt possession are treated as resume authority.
- The injected model provider is trusted in-process executable code. Proposal output cannot bypass dispatch policy, but provider implementation side effects are not sandboxed.
- In-memory adapters are not durable and do not provide cross-process locking.
- The deterministic provider recognizes only the two golden utterance families and uses a simple timezone normalization suitable for the test slice.
- There is no HTTP/SSE endpoint, Expo client, production identity, notification scheduler, vault, model API, or production logging pipeline.
- Native vault grant authenticity is a trusted-adapter precondition; the test service validates shape, expiry, scope, and replay but performs no attestation or signature verification.
- Dependency audit findings are inherited from the existing development/deployment toolchain and should be triaged separately; no automated audit fix was applied because it could change deployment behavior.
