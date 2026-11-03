import { createFileRoute } from "@tanstack/react-router";
import { HelpTopic } from "@/client/features/help/HelpPages";

export const Route = createFileRoute("/help/authentication")({
  component: () => <HelpTopic topic="authentication" />,
});
