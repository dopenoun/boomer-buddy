export class RuntimeBoundaryError extends Error {
  readonly code: string;

  constructor(code: string, safeMessage: string) {
    super(safeMessage);
    this.name = "RuntimeBoundaryError";
    this.code = code;
  }
}

const SAFE_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ACTION_FINALIZED: "That reminder decision has already been recorded.",
  CLIENT_DISCONNECTED: "The connection ended before anything was changed.",
  COMPONENT_PAYLOAD_TOO_LARGE: "The requested display content was too large.",
  CROSS_PATRON_ACCESS: "That request belongs to a different patron.",
  ID_COLLISION: "A generated identifier could not be used safely.",
  INVALID_COMPONENT_PROPS: "The requested display content was malformed.",
  INVALID_TOOL_ARGUMENTS: "The requested action was malformed.",
  MALFORMED_AG_UI_EVENT: "The protocol event was malformed.",
  MALFORMED_AG_UI_RESUME: "The approval response was malformed.",
  MALFORMED_RESUME_REQUEST: "The approval response was malformed.",
  MALFORMED_RUN_REQUEST: "The request was malformed.",
  MALFORMED_STATE_DELTA: "The state update was malformed.",
  MALFORMED_UI_EVENT: "The display event was malformed.",
  NO_ALLOWED_CAPABILITY: "I cannot safely do that yet.",
  PROVIDER_CONFIGURATION_INVALID: "The model provider configuration was invalid.",
  PROVIDER_PROVENANCE_MISMATCH: "The model response did not match this request.",
  PROVIDER_RESPONSE_MALFORMED: "The model response was malformed.",
  SENSITIVE_RECEIPT_FIELD: "Sensitive information cannot be stored in a receipt.",
  SENSITIVE_RECEIPT_VALUE: "Sensitive information cannot be stored in a receipt.",
  UNKNOWN_COMPONENT: "The requested display component is not available.",
  UNKNOWN_CUSTOM_EVENT: "The protocol event was not recognized.",
  UNKNOWN_INTERRUPT: "That approval request is no longer available.",
  UNREGISTERED_CAPABILITY: "The requested action is not available.",
  UNSAFE_COMPONENT_PAYLOAD: "The requested display content was not safe.",
  UNSAFE_COMPONENT_PROPERTY: "The requested display content was not safe.",
  UNSUPPORTED_AG_UI_EVENT: "The protocol event type is not supported.",
  VAULT_AUTH_REPLAY: "That vault authorization has already been used.",
  VAULT_AUTH_SCOPE: "That vault authorization does not allow this action.",
  VAULT_AUTH_STALE: "That vault authorization has expired.",
  VAULT_AUTH_UNKNOWN: "That vault authorization is not available.",
  VAULT_GRANT_REPLAY: "That device authorization has already been used.",
  VAULT_GRANT_STALE: "That device authorization has expired."
});

export function safeError(error: unknown): { code: string; message: string } {
  if (error instanceof RuntimeBoundaryError) {
    const message = SAFE_ERROR_MESSAGES[error.code];
    if (message) return { code: error.code, message };
  }
  return { code: "RUNTIME_FAILURE", message: "The request could not be completed safely." };
}
