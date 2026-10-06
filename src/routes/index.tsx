import { createFileRoute } from "@tanstack/react-router";
import { PenwareApp } from "@/components/penware/penware-app";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <PenwareApp />;
}
