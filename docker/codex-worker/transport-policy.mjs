// Socket idle time is not an overall generation deadline: complex Responses
// calls can legitimately be silent for more than two minutes.
export const UPSTREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export function applyUpstreamTimeout(request, onFailure, idleMs = UPSTREAM_IDLE_TIMEOUT_MS) {
  request.setTimeout(idleMs, () => {
    onFailure("UPSTREAM_IDLE_TIMEOUT");
    const error = new Error("UPSTREAM_IDLE_TIMEOUT");
    error.code = "ETIMEDOUT";
    request.destroy(error);
  });
}
export function transportFailureCode(error) {
  return [
    "ENOTFOUND",
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "CERT_HAS_EXPIRED",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  ].includes(error?.code)
    ? error.code
    : "TRANSPORT_DENIED";
}
