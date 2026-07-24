import {
  ComposerPrimitive,
  type QuoteMessagePartProps,
  SelectionToolbarPrimitive,
} from "@assistant-ui/react";

import { Icon } from "../Icon";

export function QuoteBlock({ text }: QuoteMessagePartProps) {
  return (
    <blockquote className="message-quote">
      <Icon name="quote" size={14} />
      <span>{text}</span>
    </blockquote>
  );
}

export function SelectionToolbar() {
  return (
    <SelectionToolbarPrimitive.Root className="selection-toolbar">
      <SelectionToolbarPrimitive.Quote
        className="selection-toolbar-button selection-toolbar-quote"
      >
        <Icon name="quote" size={14} />
        <span>Quote</span>
      </SelectionToolbarPrimitive.Quote>
    </SelectionToolbarPrimitive.Root>
  );
}

export function ComposerQuotePreview() {
  return (
    <ComposerPrimitive.Quote className="composer-quote">
      <Icon name="quote" size={14} />
      <ComposerPrimitive.QuoteText className="composer-quote-text" />
      <ComposerPrimitive.QuoteDismiss
        className="composer-quote-dismiss"
        aria-label="Remove quote"
        title="Remove quote"
      >
        <Icon name="close" size={13} />
      </ComposerPrimitive.QuoteDismiss>
    </ComposerPrimitive.Quote>
  );
}
