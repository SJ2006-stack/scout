import { useEffect, useRef, useState } from "react";
import { Compass, Home, ListTodo, MapPin, Menu, MessageSquarePlus, PanelRight, Settings, X } from "lucide-react";
import type { ChatEvent } from "../shared/chatEvents.ts";
import { matchesCardFilter, type CardFilter } from "../shared/event.ts";
import { AGENTS, agentById, type AgentId } from "./agents.ts";
import { apiUrl, backendHeaders } from "./backend.ts";
import { Composer } from "./Composer.tsx";
import { emptyConversation, loadConversations, saveConversations, type Conversation, type Turn } from "./conversations.ts";
import { EventCard } from "./EventCard.tsx";
import {
  LOCATION_SESSION_KEY,
  requestBrowserLocation,
  serializeLocationSession,
  type LocationFailure,
  type LocationFix,
} from "./locationSession.ts";
import { readSse } from "./sse.ts";

type Screen =
  | { kind: "home" }
  | { kind: "explore" }
  | { kind: "tasks" }
  | { kind: "settings" }
  | { kind: "chat"; conversationId: string };

type Place = { lat: number; lon: number };

type LocationView =
  | { kind: "idle" }
  | { kind: "reading"; step: "device" | "address" }
  | { kind: "done"; address: string }
  | { kind: "error"; message: string };

const PROMPTS: { label: string; agent: AgentId }[] = [
  { label: "Find comedy shows in Delhi this weekend.", agent: "event" },
  { label: "Compare cabs to the airport.", agent: "travel" },
  { label: "Find good restaurants near me.", agent: "food" },
  { label: "Plan a weekend trip.", agent: "travel" },
];

const FILTERS: { id: CardFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "comedy", label: "Comedy" },
  { id: "music", label: "Music" },
  { id: "workshop", label: "Workshops" },
  { id: "movie", label: "Movies" },
  { id: "other", label: "Other" },
];

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "home" });
  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [filter, setFilter] = useState<CardFilter>("all");
  const [place, setPlace] = useState<Place | null>(null);
  const [pincode, setPincode] = useState("");
  const [location, setLocation] = useState<LocationView>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    saveConversations(conversations);
  }, [conversations]);

  useEffect(() => {
    if (toast == null) return;
    const timer = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(timer);
  }, [toast]);

  const active = screen.kind === "chat" ? conversations.find((item) => item.id === screen.conversationId) ?? null : null;

  function openChat(conversation: Conversation): void {
    setScreen({ kind: "chat", conversationId: conversation.id });
    setSidebarOpen(false);
    setFilter("all");
  }

  function startChat(agent: AgentId): Conversation {
    const existing = conversations.find((item) => item.agent === agent && item.title === "New chat" && item.turns.length <= 1);
    if (existing) {
      openChat(existing);
      return existing;
    }
    const created = emptyConversation(agent, agentById(agent).intro);
    setConversations((current) => [created, ...current]);
    openChat(created);
    return created;
  }

  function newChat(): void {
    const agent = active?.agent ?? "main";
    const created = emptyConversation(agent, agentById(agent).intro);
    setConversations((current) => [created, ...current]);
    openChat(created);
    setDraft("");
  }

  function patch(id: string, update: (conversation: Conversation) => Conversation): void {
    setConversations((current) => current.map((item) => (item.id === id ? update(item) : item)));
  }

  async function submit(conversation: Conversation, text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0 || busyId != null) return;
    setDraft("");
    setFilter("all");
    setActivityOpen(true);
    const title = conversation.title === "New chat" ? trimmed.slice(0, 72) : conversation.title;
    patch(conversation.id, (current) => ({
      ...current,
      title,
      activity: ["Message sent."],
      turns: [...current.turns, { kind: "user", text: trimmed }],
      updatedAt: Date.now(),
    }));
    if (conversation.agent !== "event") {
      patch(conversation.id, (current) => ({
        ...current,
        turns: [...current.turns, { kind: "text", text: agentById(conversation.agent).unavailable }],
        updatedAt: Date.now(),
      }));
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusyId(conversation.id);
    try {
      const response = await fetch(apiUrl("/api/chat"), {
        method: "POST",
        headers: backendHeaders({ "content-type": "application/json" }, conversation.sessionId),
        body: JSON.stringify({
          text: trimmed,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          pincode,
          lat: place?.lat ?? null,
          lon: place?.lon ?? null,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: unknown };
        const message = typeof payload.error === "string" ? payload.error : "Scout could not answer.";
        setDraft(trimmed);
        patch(conversation.id, (current) => ({
          ...current,
          turns: [...current.turns, { kind: "text", text: message }],
          updatedAt: Date.now(),
        }));
        return;
      }
      await readSse<ChatEvent>(response, (event) => {
        const nextTurns = turnsFrom(event);
        const activityLine = activityFrom(event);
        patch(conversation.id, (current) => ({
          ...current,
          turns: nextTurns.length > 0 ? [...current.turns, ...nextTurns] : current.turns,
          activity: activityLine ? [...current.activity, activityLine] : current.activity,
          updatedAt: Date.now(),
        }));
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        patch(conversation.id, (current) => ({
          ...current,
          activity: [...current.activity, "Stopped."],
          turns: [...current.turns, { kind: "note", text: "Stopped." }],
          updatedAt: Date.now(),
        }));
        return;
      }
      setDraft(trimmed);
      patch(conversation.id, (current) => ({
        ...current,
        turns: [...current.turns, { kind: "text", text: "The chat could not be reached." }],
        updatedAt: Date.now(),
      }));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusyId((current) => (current === conversation.id ? null : current));
    }
  }

  function sendDraft(): void {
    if (screen.kind === "home") {
      const created = emptyConversation("main", agentById("main").intro);
      setConversations((current) => [created, ...current]);
      openChat(created);
      void submit(created, draft);
      return;
    }
    if (screen.kind !== "chat" || active == null) return;
    void submit(active, draft);
  }

  function usePrompt(agent: AgentId, text: string): void {
    const created = emptyConversation(agent, agentById(agent).intro);
    setConversations((current) => [created, ...current]);
    openChat(created);
    void submit(created, text);
  }

  function stop(): void {
    abortRef.current?.abort();
  }

  async function detect(): Promise<void> {
    setLocation({ kind: "reading", step: "device" });
    const result = await requestBrowserLocation({ fresh: true });
    if (!result.ok) {
      setLocation({ kind: "error", message: failureMessage(result.failure) });
      return;
    }
    setLocation({ kind: "reading", step: "address" });
    const lookedUp = await lookupAddress(result.fix);
    if ("error" in lookedUp) {
      setLocation({ kind: "error", message: lookedUp.error });
      return;
    }
    const nextPincode = /^\d{6}$/.test(lookedUp.postalCode) ? lookedUp.postalCode : "";
    sessionStorage.setItem(
      LOCATION_SESSION_KEY,
      serializeLocationSession({
        lat: result.fix.lat,
        lon: result.fix.lon,
        pincode: nextPincode,
        confirmed: true,
        accuracyMeters: result.fix.accuracyMeters,
        detectedAt: result.fix.detectedAt,
      }),
    );
    setPlace({ lat: result.fix.lat, lon: result.fix.lon });
    if (nextPincode.length > 0) setPincode(nextPincode);
    setLocation({ kind: "done", address: lookedUp.address });
  }

  const recent = [...conversations].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 8);
  const busy = busyId != null;

  return (
    <div className="shell">
      <aside className={sidebarOpen ? "sidebar open" : "sidebar"}>
        <div className="brand">
          <span className="logo">S</span>
          <strong>Scout</strong>
        </div>
        <button className="nav" type="button" onClick={newChat}>
          <MessageSquarePlus size={18} />
          New Chat
        </button>
        <button className="nav" type="button" onClick={() => { setScreen({ kind: "home" }); setSidebarOpen(false); }}>
          <Home size={18} />
          Home
        </button>
        <button className="nav" type="button" onClick={() => { setScreen({ kind: "explore" }); setSidebarOpen(false); }}>
          <Compass size={18} />
          Explore
        </button>
        <p className="nav-label">Specialists</p>
        {AGENTS.map((agent) => {
          const Icon = agent.icon;
          const selected = active?.agent === agent.id;
          return (
            <button className={selected ? "nav selected" : "nav"} type="button" key={agent.id} onClick={() => startChat(agent.id)}>
              <Icon size={18} />
              {agent.name}
            </button>
          );
        })}
        <p className="nav-label">Recent</p>
        {recent.length === 0 ? <p className="nav-empty">No conversations yet.</p> : null}
        {recent.map((conversation) => (
          <button className="nav recent" type="button" key={conversation.id} onClick={() => openChat(conversation)}>
            {conversation.title}
          </button>
        ))}
        <div className="sidebar-foot">
          <button className="nav" type="button" onClick={() => { setScreen({ kind: "tasks" }); setSidebarOpen(false); }}>
            <ListTodo size={18} />
            Tasks
          </button>
          <button className="nav" type="button" onClick={() => { setScreen({ kind: "settings" }); setSidebarOpen(false); }}>
            <Settings size={18} />
            Settings
          </button>
        </div>
      </aside>
      {sidebarOpen ? <button className="backdrop" type="button" aria-label="Close menu" onClick={() => setSidebarOpen(false)} /> : null}
      <main className="stage">
        <header className="stage-bar">
          <button className="icon-button menu" type="button" aria-label="Open menu" onClick={() => setSidebarOpen(true)}>
            <Menu size={18} />
          </button>
          <StageTitle screen={screen} conversation={active} />
          {active?.agent === "event" ? (
            <button className="text-button" type="button" onClick={() => void detect()} disabled={location.kind === "reading"}>
              <MapPin size={16} />
              {location.kind === "reading" ? "Finding your address…" : "Detect your location"}
            </button>
          ) : <span />}
          {active ? (
            <button className="icon-button" type="button" aria-label="Activity" title="Activity" onClick={() => setActivityOpen((open) => !open)}>
              <PanelRight size={18} />
            </button>
          ) : null}
        </header>
        {location.kind !== "idle" && active?.agent === "event" ? <p className="location-line"><LocationLine view={location} /></p> : null}
        <section className="transcript" aria-live="polite">
          {screen.kind === "home" ? (
            <div className="welcome">
              <h2>What can I help you with?</h2>
              <p>Discover events, compare travel options and handle everyday tasks with Scout.</p>
              <Composer
                value={draft}
                busy={busy}
                placeholder="Message Scout…"
                onChange={setDraft}
                onSend={sendDraft}
                onStop={stop}
                onToast={setToast}
              />
              <div className="prompt-row">
                {PROMPTS.map((prompt) => (
                  <button className="chip" type="button" key={prompt.label} onClick={() => usePrompt(prompt.agent, prompt.label)}>
                    {prompt.label}
                  </button>
                ))}
              </div>
              <div className="specialist-grid">
                {AGENTS.filter((agent) => agent.id === "event" || agent.id === "travel" || agent.id === "food" || agent.id === "shop").map((agent) => {
                  const Icon = agent.icon;
                  return (
                    <button className="specialist" type="button" key={agent.id} onClick={() => startChat(agent.id)}>
                      <Icon size={18} />
                      <strong>{agent.name}</strong>
                      <span>{agent.description}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <StageBody
              screen={screen}
              conversation={active}
              filter={filter}
              busy={busyId != null && busyId === active?.id}
              onFilter={setFilter}
            />
          )}
        </section>
        {screen.kind === "chat" ? (
          <Composer
            value={draft}
            busy={busy && busyId === active?.id}
            placeholder="Message Scout…"
            onChange={setDraft}
            onSend={sendDraft}
            onStop={stop}
            onToast={setToast}
          />
        ) : null}
      </main>
      {activityOpen && active ? (
        <aside className="activity">
          <div className="activity-bar">
            <strong>Activity</strong>
            <button className="icon-button" type="button" aria-label="Close activity" onClick={() => setActivityOpen(false)}>
              <X size={16} />
            </button>
          </div>
          {active.activity.length === 0 ? <p className="muted">Nothing is running.</p> : null}
          <ol>
            {active.activity.map((line, index) => (
              <li key={`${index}-${line}`}>{line}</li>
            ))}
          </ol>
        </aside>
      ) : null}
      {toast ? <p className="toast" role="status">{toast}</p> : null}
    </div>
  );
}

function StageTitle({ screen, conversation }: { screen: Screen; conversation: Conversation | null }) {
  switch (screen.kind) {
    case "home":
      return <h1>Scout</h1>;
    case "explore":
      return <h1>Explore</h1>;
    case "tasks":
      return <h1>Tasks</h1>;
    case "settings":
      return <h1>Settings</h1>;
    case "chat": {
      if (conversation == null) return <h1>Scout</h1>;
      const agent = agentById(conversation.agent);
      const Icon = agent.icon;
      return (
        <h1 className="agent-title">
          <Icon size={18} />
          {agent.name}
        </h1>
      );
    }
    default: {
      const neverScreen: never = screen;
      return neverScreen;
    }
  }
}

function StageBody({
  screen,
  conversation,
  filter,
  busy,
  onFilter,
}: {
  screen: Exclude<Screen, { kind: "home" }>;
  conversation: Conversation | null;
  filter: CardFilter;
  busy: boolean;
  onFilter: (filter: CardFilter) => void;
}) {
  switch (screen.kind) {
    case "explore":
      return <p className="plain">Explore is not connected yet.</p>;
    case "tasks":
      return <p className="plain">Tasks are not connected yet.</p>;
    case "settings":
      return <p className="plain">Settings are not connected yet.</p>;
    case "chat":
      if (conversation == null) return <p className="plain">That conversation is no longer on this device.</p>;
      return <Transcript conversation={conversation} filter={filter} busy={busy} onFilter={onFilter} />;
    default: {
      const neverScreen: never = screen;
      return neverScreen;
    }
  }
}

function Transcript({
  conversation,
  filter,
  busy,
  onFilter,
}: {
  conversation: Conversation;
  filter: CardFilter;
  busy: boolean;
  onFilter: (filter: CardFilter) => void;
}) {
  const cards = conversation.turns.filter((turn): turn is Extract<Turn, { kind: "card" }> => turn.kind === "card");
  const visibleCards = cards.filter((turn) => matchesCardFilter(turn.listing.kind, filter));
  return (
    <div className="thread">
      {conversation.agent === "event" && cards.length > 0 ? (
        <div className="filters" role="group" aria-label="Categories">
          {FILTERS.map((item) => (
            <button className={filter === item.id ? "chip on" : "chip"} type="button" key={item.id} onClick={() => onFilter(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
      {conversation.turns.map((turn, index) => (
        <TurnView key={`${turn.kind}-${index}`} turn={turn} filter={filter} />
      ))}
      {conversation.agent === "event" && cards.length > 0 && visibleCards.length === 0 ? (
        <p className="plain">None of the cards on screen are in that category.</p>
      ) : null}
      {busy ? (
        <div className="skeletons" aria-hidden="true">
          <span className="skeleton" />
          <span className="skeleton" />
          <span className="skeleton" />
        </div>
      ) : null}
    </div>
  );
}

function TurnView({ turn, filter }: { turn: Turn; filter: CardFilter }) {
  switch (turn.kind) {
    case "user":
      return <p className="user">{turn.text}</p>;
    case "text":
      return <p className="reply">{turn.text}</p>;
    case "note":
      return <p className="note">{turn.text}</p>;
    case "card":
      if (!matchesCardFilter(turn.listing.kind, filter)) return null;
      return <EventCard listing={turn.listing} />;
    default: {
      const neverTurn: never = turn;
      return neverTurn;
    }
  }
}

function LocationLine({ view }: { view: LocationView }) {
  switch (view.kind) {
    case "idle":
      return null;
    case "reading":
      return view.step === "device" ? "Asking this browser for its location." : "Turning that into an address.";
    case "error":
      return view.message;
    case "done":
      return view.address;
    default: {
      const neverView: never = view;
      return neverView;
    }
  }
}

function turnsFrom(event: ChatEvent): Turn[] {
  switch (event.type) {
    case "question":
    case "status":
      return [{ kind: "text", text: event.message }];
    case "source":
      return event.ok ? [] : [{ kind: "note", text: event.message }];
    case "card":
      return [{ kind: "card", listing: event.listing }];
    case "done":
      return [];
    default: {
      const neverEvent: never = event;
      return neverEvent;
    }
  }
}

function activityFrom(event: ChatEvent): string | null {
  switch (event.type) {
    case "status":
    case "source":
      return event.message;
    case "question":
    case "card":
    case "done":
      return null;
    default: {
      const neverEvent: never = event;
      return neverEvent;
    }
  }
}

async function lookupAddress(fix: LocationFix): Promise<{ address: string; postalCode: string } | { error: string }> {
  try {
    const response = await fetch(apiUrl("/api/location/reverse-geocode"), {
      method: "POST",
      headers: backendHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        latitude: fix.lat,
        longitude: fix.lon,
        accuracyMeters: fix.accuracyMeters,
      }),
    });
    const payload = (await response.json()) as { formattedAddress?: unknown; postalCode?: unknown; error?: unknown };
    if (!response.ok) {
      return { error: typeof payload.error === "string" ? payload.error : "No address was found for that point." };
    }
    if (typeof payload.formattedAddress !== "string" || payload.formattedAddress.trim().length === 0) {
      return { error: "No address was found for that point." };
    }
    return {
      address: payload.formattedAddress.trim(),
      postalCode: typeof payload.postalCode === "string" ? payload.postalCode : "",
    };
  } catch {
    return { error: "The address service could not be reached." };
  }
}

function failureMessage(failure: LocationFailure): string {
  switch (failure) {
    case "denied":
      return "Location permission was denied.";
    case "unavailable":
      return "This device could not provide a location.";
    case "timeout":
      return "Location took too long. Try again.";
    case "unsupported":
      return "This browser cannot detect location.";
    case "insecure":
      return "Location needs a secure page.";
    default: {
      const neverFailure: never = failure;
      return neverFailure;
    }
  }
}
