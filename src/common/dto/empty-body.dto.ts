/**
 * Used on bodyless write endpoints (Body: none) so empty body or {} passes,
 * while any unexpected field is rejected with 400 UNKNOWN_FIELD (Contract §0.2, §0.11).
 */
export class EmptyBodyDto {}
