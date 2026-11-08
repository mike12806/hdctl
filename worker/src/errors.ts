/** A secret or binding an integration needs is missing: answered as 503 with this message. */
export class NotConfigured extends Error {}

/** The system hdctl called answered with an error: answered as 502. */
export class UpstreamError extends Error {}

/** The request itself is wrong (unknown host, bad vmid, ...): answered as 400. */
export class BadRequest extends Error {}
