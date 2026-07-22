import {
  startWebhookAdapter,
  type WebhookAdapterOptions,
} from "../../index.js";

declare const responder: WebhookAdapterOptions["responder"];

const apiKey = process.env.MONO_AGENT_WEBHOOK_API_KEY;
void startWebhookAdapter({
  host: "127.0.0.1",
  port: 4310,
  ...(apiKey === undefined ? {} : { apiKey }),
  responder,
  endpoints: [
    { name: "invoke", path: "/webhook/invoke" },
    {
      name: "deep-research",
      path: "/webhook/deep-research",
      mode: "async",
      prompt: "Check deep-research/requests/*.md, match the incoming payload, address it, then move the file to deep-research/researched/.",
    },
  ],
});
