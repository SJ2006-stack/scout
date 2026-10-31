import { ChevronRight, ShieldCheck } from "lucide-react";
import { publicScoutUrl, type AgentId } from "../shared/hosts.ts";
import { AGENTS, agentById } from "./agents.ts";
import { promptsFor } from "./prompts.ts";
import { greeting } from "./uiText.ts";

export type BookingLink = "checking" | "needed" | "saved" | "off";

type WelcomeProps = {
  siteAgent: AgentId;
  name: string | null;
  link: BookingLink;
  onPrompt: (text: string) => void;
};

export function Welcome({ siteAgent, name, link, onPrompt }: WelcomeProps) {
  if (siteAgent === "main") return <Hub name={name} />;
  const agent = agentById(siteAgent);
  const Icon = agent.icon;
  return (
    <div className="welcome">
      <span className="welcome-icon" aria-hidden="true"><Icon size={24} /></span>
      <h2>{greeting(name)}</h2>
      <p className="welcome-lead">{agent.intro}</p>
      <div className="prompt-list" role="group" aria-label="Things to try">
        {promptsFor(siteAgent).map((label) => (
          <button className="prompt" type="button" key={label} onClick={() => onPrompt(label)}>
            <span>{label}</span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        ))}
      </div>
      {siteAgent === "event" ? <BookingStatus link={link} /> : null}
    </div>
  );
}

function BookingStatus({ link }: { link: BookingLink }) {
  switch (link) {
    case "saved":
      return (
        <p className="welcome-status">
          <ShieldCheck size={16} aria-hidden="true" />
          Booking sites are connected. Your sign-in is saved and encrypted.
        </p>
      );
    case "needed":
      return (
        <p className="welcome-status">
          <ShieldCheck size={16} aria-hidden="true" />
          The first time you book, Scout signs in with your Gmail or phone number and asks you to approve a code.
        </p>
      );
    case "checking":
    case "off":
      return null;
    default: {
      const neverLink: never = link;
      return neverLink;
    }
  }
}

function Hub({ name }: { name: string | null }) {
  const specialists = AGENTS.filter((agent) => agent.id !== "main");
  return (
    <div className="welcome hub">
      <h2>{greeting(name)}</h2>
      <p className="welcome-lead">What do you need help with? Pick a Scout.</p>
      <div className="specialist-grid">
        {specialists.map((agent) => {
          const Icon = agent.icon;
          return (
            <a className="specialist" key={agent.id} href={publicScoutUrl(agent.id)}>
              <span className="specialist-icon" aria-hidden="true"><Icon size={20} /></span>
              <strong>{agent.name}</strong>
              <span className="specialist-copy">{agent.description}</span>
              {agent.unavailable.length > 0 ? <span className="badge">Not connected yet</span> : null}
            </a>
          );
        })}
      </div>
    </div>
  );
}
