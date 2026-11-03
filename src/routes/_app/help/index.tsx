import { createFileRoute } from "@tanstack/react-router";
import { HelpHub } from "@/client/features/help/HelpPages";

export const Route = createFileRoute("/_app/help/")({ component: HelpHub });
