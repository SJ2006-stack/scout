import { ListTodo, Settings, SquarePen, Trash2 } from "lucide-react";
import { publicScoutUrl, type AgentId } from "../shared/hosts.ts";
import { AGENTS } from "./agents.ts";
import type { Conversation } from "./conversations.ts";
import type { Account, Screen } from "./screen.ts";
import { initialOf } from "./uiText.ts";

type SidebarProps = {
  open: boolean;
  siteAgent: AgentId;
  screen: Screen;
  recent: Conversation[];
  account: Account;
  onHome: () => void;
  onNewChat: () => void;
  onTasks: () => void;
  onSettings: () => void;
  onOpenChat: (conversation: Conversation) => void;
  onDelete: (id: string) => void;
};

export function Sidebar({
  open,
  siteAgent,
  screen,
  recent,
  account,
  onHome,
  onNewChat,
  onTasks,
  onSettings,
  onOpenChat,
  onDelete,
}: SidebarProps) {
  const onAgentScreen = screen.kind === "home" || screen.kind === "chat";
  return (
    <aside className={open ? "sidebar open" : "sidebar"} aria-label="Scout menu">
      <button className="brand" type="button" onClick={onHome} aria-label="Scout home">
        <span className="logo">S</span>
        <strong>Scout</strong>
      </button>
      {siteAgent === "main" ? null : (
        <button className="new-chat" type="button" onClick={onNewChat}>
          <SquarePen size={16} aria-hidden="true" />
          New chat
        </button>
      )}
      <p className="nav-label">Scouts</p>
      {AGENTS.filter((agent) => agent.id !== "main").map((agent) => {
        const Icon = agent.icon;
        const soon = agent.unavailable.length > 0;
        if (agent.id === siteAgent) {
          return (
            <button
              className={onAgentScreen ? "nav selected" : "nav"}
              type="button"
              key={agent.id}
              aria-current={onAgentScreen ? "page" : undefined}
              onClick={onHome}
            >
              <Icon size={18} aria-hidden="true" />
              {agent.name}
            </button>
          );
        }
        return (
          <a className="nav" key={agent.id} href={publicScoutUrl(agent.id)}>
            <Icon size={18} aria-hidden="true" />
            <span className="nav-text">{agent.name}</span>
            {soon ? <span className="badge">Soon</span> : null}
          </a>
        );
      })}
      {siteAgent === "main" ? null : (
        <>
          <p className="nav-label">Recent</p>
          {recent.length === 0 ? <p className="nav-empty">Your chats show up here.</p> : null}
          {recent.map((conversation) => (
            <div className="recent-row" key={conversation.id}>
              <button
                className={screen.kind === "chat" && screen.conversationId === conversation.id ? "nav recent selected" : "nav recent"}
                type="button"
                onClick={() => onOpenChat(conversation)}
              >
                {conversation.title}
              </button>
              <button
                className="icon-button recent-delete"
                type="button"
                aria-label={`Delete ${conversation.title}`}
                title="Delete chat"
                onClick={() => onDelete(conversation.id)}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </>
      )}
      <div className="sidebar-foot">
        <button
          className={screen.kind === "tasks" ? "nav selected" : "nav"}
          type="button"
          aria-current={screen.kind === "tasks" ? "page" : undefined}
          onClick={onTasks}
        >
          <ListTodo size={18} aria-hidden="true" />
          Tasks
        </button>
        <button
          className={screen.kind === "settings" ? "account selected" : "account"}
          type="button"
          aria-current={screen.kind === "settings" ? "page" : undefined}
          onClick={onSettings}
        >
          <span className="avatar" aria-hidden="true">{initialOf(account.name, account.email)}</span>
          <span className="account-text">
            <strong>{account.name ?? "Your account"}</strong>
            <span>{account.email ?? "Settings"}</span>
          </span>
          <Settings size={16} aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
}
