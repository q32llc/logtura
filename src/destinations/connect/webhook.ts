import { DestinationError } from "@logtura/core";
import type { WebhookConfig } from "@logtura/destination-webhook";
import type { DestinationConnectAdapter } from "./types";

export const webhookConnect: DestinationConnectAdapter<WebhookConfig> = {
  driverId: "webhook",
  formFields: [
    {
      name: "url",
      label: "Webhook URL",
      type: "text",
      placeholder: "https://hooks.example.com/...",
      description:
        "logtura POSTs JSON-encoded log lines here. Use HTTPS only.",
      required: true,
    },
  ],
  parseFormData(form) {
    const url = String(form.get("url") ?? "").trim();
    if (!url) throw new DestinationError("Missing webhook URL", 400);
    if (!/^https:\/\//.test(url)) {
      throw new DestinationError("URL must start with https://", 400);
    }
    return { config: { url } };
  },
};
