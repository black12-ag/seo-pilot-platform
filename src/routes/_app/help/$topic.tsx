import { createFileRoute } from "@tanstack/react-router";
import { HelpTopic } from "@/client/features/help/HelpPages";

export const Route = createFileRoute("/_app/help/$topic")({
  component: TopicPage,
});

function TopicPage() {
  const { topic } = Route.useParams();
  return <HelpTopic topic={topic} />;
}
