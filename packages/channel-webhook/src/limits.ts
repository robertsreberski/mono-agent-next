export const MAX_WEBHOOK_TEXT_LENGTH = 1_000_000;
export const MAX_WEBHOOK_TEXT_BYTES = MAX_WEBHOOK_TEXT_LENGTH * 4;

// Reserve two separators plus one non-empty Unicode scalar for every loaded route.
export const MAX_WEBHOOK_ROUTE_PROMPT_LENGTH = MAX_WEBHOOK_TEXT_LENGTH - 4;
