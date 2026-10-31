import { useEffect, useRef, useState } from "react";
import { MapPin, Menu } from "lucide-react";
import type { ChatEvent } from "../shared/chatEvents.ts";
import type { CommerceEvent } from "../shared/commerce.ts";
import { matchesCardFilter, type CardFilter, type Listing } from "../shared/event.ts";
import type { AgentId } from "../shared/hosts.ts";
import { onboardingStep, PLAN_PROMPT } from "../shared/onboarding.ts";
import { speechCue } from "../shared/speech.ts";
import { matchControl, readBrowseCommand, type BrowserControl, type BrowseCommand } from "../shared/browse.ts";
import type { BrowserTaskEvent } from "../shared/browser.ts";
import { commerceAgent } from "./agentRoute.ts";
import { agentById } from "./agents.ts";
import { apiUrl, backendHeaders, forgetSignedInUser, rememberSignedInUser } from "./backend.ts";
import { CartCard, PayCard, QuoteCard, ReceiptCard } from "./CommerceCard.tsx";
import { Composer } from "./Composer.tsx";
import { deleteConversation } from "./conversationList.ts";
import { conversationsFromStorage, emptyConversation, loadConversations, mergeConversations, saveConversations, type Conversation, type Turn } from "./conversations.ts";
import { siteAgentFromHealth, siteAgentFromLocation } from "./site.ts";
import { PreferredName, SignIn, Splash } from "./SignIn.tsx";
import { BrowserTasks } from "./BrowserTasks.tsx";
import { EventCard } from "./EventCard.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { Welcome, type BookingLink } from "./Welcome.tsx";
import type { Account, Screen, Toast } from "./screen.ts";
import { filterCounts, hasUserTurn } from "./uiText.ts";
import {
  LOCATION_SESSION_KEY,
  requestBrowserLocation,
  serializeLocationSession,
  type LocationFailure,
  type LocationFix,
} from "./locationSession.ts";
import { readSse } from "./sse.ts";
import { rememberVoiceReplies, speakReply, stopSpeech, voiceRepliesEnabled } from "./voice.ts";
import { Thinking } from "./Thinking.tsx";
import { appendThought, finishThought } from "../shared/thinking.ts";
import { withEmoji } from "../shared/emoji.ts";

type Place = { lat: number; lon: number };

type LocationView =
  | { kind: "idle" }
  | { kind: "reading"; step: "device" | "address" }
  | { kind: "done"; address: string }
  | { kind: "error"; message: string };

const FILTERS: { id: CardFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "comedy", label: "Comedy" },
  { id: "music", label: "Music" },
  { id: "workshop", label: "Workshops" },
  { id: "movie", label: "Movies" },
  { id: "other", label: "Other" },
];

export function App() {
  const [siteAgent, setSiteAgent] = useState<AgentId>(() => siteAgentFromLocation(window.location.hostname, window.location.pathname) ?? "event");
  const [screen, setScreen] = useState<Screen>({ kind: "home" });
  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [account, setAccount] = useState<Account>({ name: null, email: null, phone: null });
  const transcriptRef = useRef<HTMLElement>(null);
  const stickToEnd = useRef(true);
  const [filter, setFilter] = useState<CardFilter>("all");
  const [place, setPlace] = useState<Place | null>(null);
  const [pincode, setPincode] = useState("");
  const [location, setLocation] = useState<LocationView>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const publishDesk = useRef(false);
  const [voiceReplies, setVoiceReplies] = useState(voiceRepliesEnabled);
  const voiceRepliesRef = useRef(voiceReplies);
  voiceRepliesRef.current = voiceReplies;
  const [gate, setGate] = useState<"checking" | "out" | "phone" | "name" | "in">("checking");
  const [link, setLink] = useState<BookingLink>("checking");

  useEffect(() => {
    saveConversations(conversations);
    if (gate !== "in" || !publishDesk.current) return;
    void fetch(apiUrl("/api/desk"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversations }),
    });
  }, [conversations, gate]);

  useEffect(() => {
    if (gate !== "in") return;
    let cancelled = false;
    void (async () => {
      let remote: Conversation[] = [];
      try {
        const response = await fetch(apiUrl("/api/desk"));
        if (response.ok) {
          const body = (await response.json()) as { conversations?: unknown };
          remote = conversationsFromStorage(body.conversations);
        }
      } catch {
        remote = [];
      }
      if (cancelled) return;
      publishDesk.current = true;
      setConversations(mergeConversations(loadConversations(), remote));
    })();
    return () => {
      cancelled = true;
    };
  }, [gate]);

  useEffect(() => {
    let cancelled = false;
    void fetch(apiUrl("/api/auth/session"), { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) return { signedIn: false, userId: "" } as SessionBody;
        return (await response.json()) as SessionBody;
      })
      .then((body) => {
        if (cancelled) return;
        const userId = typeof body.userId === "string" ? body.userId : "";
        setAccount(accountFromSession(body));
        const signedIn = body.signedIn === true && userId.length > 0;
        if (signedIn) rememberSignedInUser(userId);
        const step = onboardingStep({
          signedIn,
          phone: typeof body.phone === "string" ? body.phone : null,
          name: typeof body.name === "string" ? body.name : null,
        });
        switch (step) {
          case "email":
            setGate("out");
            return;
          case "phone":
            setGate("phone");
            return;
          case "name":
            setGate("name");
            return;
          case "ready":
            setGate("in");
            return;
          default: {
            const neverStep: never = step;
            setGate("out");
            return neverStep;
          }
        }
      })
      .catch(() => {
        if (!cancelled) setGate("out");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (gate !== "in") return;
    const bridge = (window as Window & { ScoutOtp?: { listen: () => void } }).ScoutOtp;
    bridge?.listen();
    const onCode = (event: Event): void => {
      const code = (event as CustomEvent<string>).detail;
      if (typeof code !== "string" || !/^\d{4,8}$/.test(code)) return;
      void fetch(apiUrl("/api/browser/code"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
    };
    window.addEventListener("scout-otp", onCode);
    return () => window.removeEventListener("scout-otp", onCode);
  }, [gate]);

  useEffect(() => {
    if (gate !== "in" || siteAgent === "main") return;
    let cancelled = false;
    void fetch(apiUrl("/api/browser/profile"), { credentials: "include" })
      .then(async (response) => {
        if (cancelled) return;
        if (response.status === 503) {
          setLink("off");
          return;
        }
        if (!response.ok) {
          setLink("needed");
          return;
        }
        const body = (await response.json()) as { profile?: { state?: string } };
        setLink(body.profile?.state === "saved" ? "saved" : "needed");
      })
      .catch(() => {
        if (!cancelled) setLink("off");
      });
    return () => {
      cancelled = true;
    };
  }, [gate, siteAgent]);

  useEffect(() => {
    const fromLocation = siteAgentFromLocation(window.location.hostname, window.location.pathname);
    if (fromLocation) {
      setSiteAgent(fromLocation);
      return;
    }
    void siteAgentFromHealth().then((agent) => {
      if (agent) setSiteAgent(agent);
    });
  }, []);

  useEffect(() => {
    if (screen.kind !== "chat") return;
    const open = conversations.find((item) => item.id === screen.conversationId);
    if (open && open.agent !== siteAgent) setScreen({ kind: "home" });
  }, [siteAgent, screen, conversations]);

  useEffect(() => {
    if (toast == null) return;
    const timer = setTimeout(() => setToast(null), toast.action ? 6000 : 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const element = transcriptRef.current;
    if (element && stickToEnd.current) element.scrollTop = element.scrollHeight;
  });

  const active = screen.kind === "chat" ? conversations.find((item) => item.id === screen.conversationId) ?? null : null;

  function showToast(text: string): void {
    setToast({ text });
  }

  function goTo(next: Screen): void {
    stickToEnd.current = true;
    setScreen(next);
    setSidebarOpen(false);
  }

  function openChat(conversation: Conversation): void {
    setFilter("all");
    goTo({ kind: "chat", conversationId: conversation.id });
  }

  function newChat(): void {
    setDraft("");
    goTo({ kind: "home" });
  }

  function startConversation(): Conversation {
    if (siteAgent === "main") throw new Error("The hub has no chats.");
    const created = { ...emptyConversation(siteAgent, agentById(siteAgent).intro), turns: [] };
    setConversations((current) => [created, ...current]);
    openChat(created);
    return created;
  }

  function deleteChat(id: string): void {
    const index = conversations.findIndex((item) => item.id === id);
    const removed = conversations[index];
    if (!removed) return;
    setConversations((current) => deleteConversation(current, id));
    if (screen.kind === "chat" && screen.conversationId === id) {
      goTo({ kind: "home" });
      setDraft("");
    }
    if (busyId === id) abortRef.current?.abort();
    if (!hasUserTurn(removed)) return;
    setToast({
      text: "Chat deleted.",
      action: {
        label: "Undo",
        run: () => {
          setConversations((current) => (current.some((item) => item.id === id) ? current : [removed, ...current]));
          setToast(null);
        },
      },
    });
  }

  function patch(id: string, update: (conversation: Conversation) => Conversation): void {
    setConversations((current) => current.map((item) => (item.id === id ? update(item) : item)));
  }

  async function submit(conversation: Conversation, text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0 || busyId != null) return;
    setDraft("");
    setFilter("all");
    stickToEnd.current = true;
    const title = conversation.title === "New chat" ? trimmed.slice(0, 72) : conversation.title;
    const browse = readBrowseCommand(trimmed);
    patch(conversation.id, (current) => {
      const spoken = [...current.turns, { kind: "user" as const, text: trimmed }];
      return {
        ...current,
        title,
        activity: ["Message sent."],
        turns: beginThinking(spoken, ["Message sent."]),
        updatedAt: Date.now(),
      };
    });
    if (browse) {
      await sendBrowser(conversation, browse);
      return;
    }
    await sendEventChat(conversation, trimmed);
  }

  function confirmReview(conversation: Conversation, quoteId: string): void {
    if (busyId != null) return;
    const agent = commerceAgent(conversation.agent);
    if (!agent) return;
    patch(conversation.id, (current) => ({
      ...current,
      activity: [...current.activity, "Confirmation sent."],
      turns: beginThinking(current.turns),
      updatedAt: Date.now(),
    }));
    void sendCommerce(conversation, { agent, action: "confirm", quoteId });
  }

  async function sendBook(conversation: Conversation, listing: Listing): Promise<void> {
    if (busyId != null) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusyId(conversation.id);
    const step = listing.platform === "Luma" ? "Registering for the event." : "Opening the pay screen.";
    const failure = listing.platform === "Luma" ? "Registration did not finish." : "The pay screen could not be opened.";
    patch(conversation.id, (current) => ({
      ...current,
      activity: [...current.activity, step],
      turns: beginThinking(current.turns, [step]),
      updatedAt: Date.now(),
    }));
    try {
      const response = await fetch(apiUrl("/api/pay"), {
        method: "POST",
        headers: backendHeaders({ "content-type": "application/json" }, conversation.sessionId),
        body: JSON.stringify({ url: listing.url, title: listing.title }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: unknown };
        const message = typeof payload.error === "string" ? payload.error : failure;
        patch(conversation.id, (current) => ({
          ...current,
          turns: [...sealThinking(current.turns), { kind: "text", text: message }],
          updatedAt: Date.now(),
        }));
        return;
      }
      await readSse<CommerceEvent>(response, (event) => {
        const nextTurns = turnsFromCommerce(event);
        const activityLine = activityFromCommerce(event);
        patch(conversation.id, (current) => ({
          ...current,
          turns: traceTurns(current.turns, nextTurns, activityLine, event.type === "done"),
          activity: activityLine ? [...current.activity, activityLine] : current.activity,
          updatedAt: Date.now(),
        }));
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        patch(conversation.id, (current) => ({
          ...current,
          turns: [...sealThinking(current.turns), { kind: "note", text: "Stopped." }],
          updatedAt: Date.now(),
        }));
        return;
      }
      patch(conversation.id, (current) => ({
        ...current,
        turns: [...sealThinking(current.turns), { kind: "text", text: failure }],
        updatedAt: Date.now(),
      }));
    } finally {
      patch(conversation.id, (current) => ({ ...current, turns: sealThinking(current.turns) }));
      if (abortRef.current === controller) abortRef.current = null;
      setBusyId((current) => (current === conversation.id ? null : current));
    }
  }

  async function sendBrowser(conversation: Conversation, command: BrowseCommand): Promise<void> {
    const controller = new AbortController();
    abortRef.current = controller;
    setBusyId(conversation.id);
    try {
      if (command.kind === "click" || command.kind === "fill") {
        const sessionId = conversation.browserSessionId;
        const control = sessionId ? matchControl(conversation.browserControls ?? [], command.name, command.kind) : null;
        if (!sessionId || !control) {
          const message = sessionId ? `No ${command.kind === "click" ? "control" : "field"} named ${command.name} is on the page.` : "Open a page first.";
          patch(conversation.id, (current) => ({
            ...current,
            turns: [...sealThinking(current.turns), { kind: "text", text: message }],
            updatedAt: Date.now(),
          }));
          return;
        }
        const path = command.kind === "click" ? "click" : "fill";
        const body = command.kind === "click" ? { ref: control.ref } : { ref: control.ref, value: command.value };
        const response = await fetch(apiUrl(`/api/browser/sessions/${sessionId}/${path}`), {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json", "bypass-tunnel-reminder": "true" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        await readBrowser(conversation.id, response);
        return;
      }
      const response = await fetch(apiUrl("/api/browser/sessions"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "bypass-tunnel-reminder": "true" },
        body: JSON.stringify({ url: command.url }),
        signal: controller.signal,
      });
      await readBrowser(conversation.id, response);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        patch(conversation.id, (current) => ({
          ...current,
          turns: [...sealThinking(current.turns), { kind: "note", text: "Stopped." }],
          updatedAt: Date.now(),
        }));
        return;
      }
      patch(conversation.id, (current) => ({
        ...current,
        turns: [...sealThinking(current.turns), { kind: "text", text: "The browser worker could not be reached." }],
        updatedAt: Date.now(),
      }));
    } finally {
      patch(conversation.id, (current) => ({ ...current, turns: sealThinking(current.turns) }));
      if (abortRef.current === controller) abortRef.current = null;
      setBusyId((current) => (current === conversation.id ? null : current));
    }
  }

  async function readBrowser(id: string, response: Response): Promise<void> {
    if (!response.ok) {
      const payload = (await response.json()) as { error?: unknown };
      const message = typeof payload.error === "string" ? payload.error : "The browser could not do that.";
      patch(id, (current) => ({
        ...current,
        turns: [...sealThinking(current.turns), { kind: "text", text: message }],
        updatedAt: Date.now(),
      }));
      return;
    }
    await readSse<BrowserTaskEvent>(response, (event) => {
      const step = browserStep(event);
      const controls = event.type === "snapshot" ? event.elements.filter(isBrowserControl) : null;
      patch(id, (current) => ({
        ...current,
        browserSessionId: event.sessionId || current.browserSessionId,
        browserControls: controls ?? current.browserControls,
        turns: traceTurns(current.turns, [], step, event.type === "done"),
        activity: step ? [...current.activity, step] : current.activity,
        updatedAt: Date.now(),
      }));
    });
  }

  async function sendEventChat(conversation: Conversation, trimmed: string): Promise<void> {
    const controller = new AbortController();
    abortRef.current = controller;
    setBusyId(conversation.id);
    try {
      const response = await fetch(apiUrl("/api/chat"), {
        method: "POST",
        headers: backendHeaders({ "content-type": "application/json" }, conversation.sessionId),
        body: JSON.stringify({
          text: trimmed,
          agent: conversation.agent,
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
          turns: [...sealThinking(current.turns), { kind: "text", text: message }],
          updatedAt: Date.now(),
        }));
        return;
      }
      let speechEpoch = 0;
      let speechStarted = false;
      let latestQuestion = "";
      const startSpeech = (sentence: string) => {
        speechEpoch += 1;
        const epoch = speechEpoch;
        void sayReply(sentence, () => epoch === speechEpoch);
      };
      await readSse<ChatEvent>(response, (event) => {
        if (event.type === "question") {
          if (event.message.trim().length === 0) {
            speechEpoch += 1;
            speechStarted = false;
            latestQuestion = "";
            stopSpeech();
          } else {
            latestQuestion = event.message;
            const sentence = speechCue(speechStarted, event.message);
            if (sentence) {
              speechStarted = true;
              startSpeech(sentence);
            }
          }
          patch(conversation.id, (current) => ({
            ...current,
            turns: applyQuestion(current.turns, event.message),
            updatedAt: Date.now(),
          }));
          return;
        }
        if (event.type === "drive") {
          patch(conversation.id, (current) => ({
            ...current,
            turns: applyDrive(current.turns, event.url, event.minutes),
            updatedAt: Date.now(),
          }));
          return;
        }
        const nextTurns = turnsFrom(event);
        const activityLine = activityFrom(event);
        patch(conversation.id, (current) => ({
          ...current,
          turns: traceTurns(current.turns, nextTurns, activityLine, event.type === "done"),
          activity: activityLine ? [...current.activity, activityLine] : current.activity,
          updatedAt: Date.now(),
        }));
      });
      if (!speechStarted && latestQuestion.trim().length > 0) startSpeech(latestQuestion);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        patch(conversation.id, (current) => ({
          ...current,
          activity: [...current.activity, "Stopped."],
          turns: [...sealThinking(current.turns), { kind: "note", text: "Stopped." }],
          updatedAt: Date.now(),
        }));
        return;
      }
      setDraft(trimmed);
      patch(conversation.id, (current) => ({
        ...current,
        turns: [...sealThinking(current.turns), { kind: "text", text: "The chat could not be reached." }],
        updatedAt: Date.now(),
      }));
    } finally {
      patch(conversation.id, (current) => ({ ...current, turns: sealThinking(current.turns) }));
      if (abortRef.current === controller) abortRef.current = null;
      setBusyId((current) => (current === conversation.id ? null : current));
    }
  }

  async function sendCommerce(
    conversation: Conversation,
    body: { agent: "shop" | "food" | "appointments"; action: "message"; text: string } | { agent: "shop" | "food" | "appointments"; action: "confirm"; quoteId: string },
  ): Promise<void> {
    const controller = new AbortController();
    abortRef.current = controller;
    setBusyId(conversation.id);
    try {
      const response = await fetch(apiUrl("/api/commerce"), {
        method: "POST",
        headers: backendHeaders({ "content-type": "application/json" }, conversation.sessionId),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: unknown };
        const message = typeof payload.error === "string" ? payload.error : "Scout could not answer.";
        if (body.action === "message") setDraft(body.text);
        patch(conversation.id, (current) => ({
          ...current,
          turns: [...sealThinking(current.turns), { kind: "text", text: message }],
          updatedAt: Date.now(),
        }));
        return;
      }
      await readSse<CommerceEvent>(response, (event) => {
        const nextTurns = turnsFromCommerce(event);
        const activityLine = activityFromCommerce(event);
        patch(conversation.id, (current) => ({
          ...current,
          turns: traceTurns(current.turns, nextTurns, activityLine, event.type === "done"),
          activity: activityLine ? [...current.activity, activityLine] : current.activity,
          updatedAt: Date.now(),
        }));
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        patch(conversation.id, (current) => ({
          ...current,
          activity: [...current.activity, "Stopped."],
          turns: [...sealThinking(current.turns), { kind: "note", text: "Stopped." }],
          updatedAt: Date.now(),
        }));
        return;
      }
      if (body.action === "message") setDraft(body.text);
      patch(conversation.id, (current) => ({
        ...current,
        turns: [...sealThinking(current.turns), { kind: "text", text: "The chat could not be reached." }],
        updatedAt: Date.now(),
      }));
    } finally {
      patch(conversation.id, (current) => ({ ...current, turns: sealThinking(current.turns) }));
      if (abortRef.current === controller) abortRef.current = null;
      setBusyId((current) => (current === conversation.id ? null : current));
    }
  }

  function sendText(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (screen.kind === "home") {
      if (siteAgent === "main") return;
      void submit(startConversation(), trimmed);
      return;
    }
    if (screen.kind !== "chat" || active == null) return;
    void submit(active, trimmed);
  }

  function allowVoice(enabled: boolean): void {
    rememberVoiceReplies(enabled);
    setVoiceReplies(enabled);
    if (!enabled) stopSpeech();
  }

  async function sayReply(text: string, stillCurrent: () => boolean): Promise<void> {
    if (!voiceRepliesRef.current || text.trim().length === 0) return;
    try {
      await speakReply(text, stillCurrent);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Scout could not speak that.");
    }
  }

  function usePrompt(text: string): void {
    if (siteAgent === "main") return;
    void submit(startConversation(), text);
  }

  function stop(): void {
    abortRef.current?.abort();
    stopSpeech();
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

  async function signOut(): Promise<void> {
    await fetch(apiUrl("/api/auth/signout"), { method: "POST", credentials: "include" });
    forgetSignedInUser();
    setGate("out");
    setLink("checking");
  }

  async function finishOnboarding(): Promise<void> {
    const next = await loadAccount();
    if (next) setAccount(next);
    setGate("in");
  }

  if (gate === "checking") return <Splash />;
  if (gate === "out" || gate === "phone") {
    return <SignIn start={gate === "phone" ? "phone" : "email"} onSignedIn={() => setGate("name")} />;
  }
  if (gate === "name") return <PreferredName onNamed={() => void finishOnboarding()} />;

  const recent = conversations
    .filter((item) => item.agent === siteAgent && hasUserTurn(item))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 12);
  const busy = busyId != null;
  const showComposer = (screen.kind === "chat" || screen.kind === "home") && siteAgent !== "main";

  return (
    <div className={sidebarOpen ? "shell menu-open" : "shell"}>
      <Sidebar
        open={sidebarOpen}
        siteAgent={siteAgent}
        screen={screen}
        recent={recent}
        account={account}
        onHome={() => goTo({ kind: "home" })}
        onNewChat={newChat}
        onTasks={() => goTo({ kind: "tasks" })}
        onSettings={() => goTo({ kind: "settings" })}
        onOpenChat={openChat}
        onDelete={deleteChat}
      />
      {sidebarOpen ? <button className="backdrop" type="button" aria-label="Close menu" onClick={() => setSidebarOpen(false)} /> : null}
      <main className="stage">
        <header className="stage-bar">
          <button className="icon-button menu" type="button" aria-label="Open menu" onClick={() => setSidebarOpen(true)}>
            <Menu size={20} />
          </button>
          <StageTitle screen={screen} conversation={active} siteAgent={siteAgent} />
          {active?.agent === "event" ? (
            <button className="text-button" type="button" onClick={() => void detect()} disabled={location.kind === "reading"}>
              <MapPin size={16} aria-hidden="true" />
              <span>{location.kind === "reading" ? "Finding you…" : location.kind === "done" ? "Update location" : "Use my location"}</span>
            </button>
          ) : null}
        </header>
        {location.kind !== "idle" && active?.agent === "event" ? (
          <p className={location.kind === "error" ? "location-line error" : "location-line"}><LocationLine view={location} /></p>
        ) : null}
        <section
          className="transcript"
          ref={transcriptRef}
          aria-live="polite"
          onScroll={(event) => {
            const element = event.currentTarget;
            stickToEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 140;
          }}
        >
          {screen.kind === "home" ? <Welcome siteAgent={siteAgent} name={account.name} link={link} onPrompt={usePrompt} /> : null}
          {screen.kind === "tasks" ? <BrowserTasks /> : null}
          {screen.kind === "settings" ? (
            <SettingsPanel
              account={account}
              voiceReplies={voiceReplies}
              onVoiceReplies={allowVoice}
              onSignOut={() => void signOut()}
              onToast={showToast}
            />
          ) : null}
          {screen.kind === "chat" ? (
            active == null ? (
              <p className="plain">That chat is no longer on this device.</p>
            ) : (
              <Transcript
                conversation={active}
                filter={filter}
                busy={busyId != null && busyId === active.id}
                onFilter={setFilter}
                onConfirm={(quoteId) => confirmReview(active, quoteId)}
                onBook={(listing) => void sendBook(active, listing)}
              />
            )
          ) : null}
        </section>
        {showComposer ? (
          <Composer
            value={draft}
            busy={screen.kind === "chat" ? busy && busyId === active?.id : busy}
            placeholder={screen.kind === "chat" ? "Message Scout…" : link === "saved" || link === "off" ? PLAN_PROMPT : `Message ${agentById(siteAgent).name}…`}
            voiceReplies={voiceReplies}
            onChange={setDraft}
            onSend={() => sendText(draft)}
            onDictate={sendText}
            onVoiceReplies={allowVoice}
            onStop={stop}
            onToast={showToast}
          />
        ) : null}
      </main>
      {toast ? (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.action ? <button type="button" onClick={toast.action.run}>{toast.action.label}</button> : null}
        </div>
      ) : null}
    </div>
  );
}

type SessionBody = { signedIn?: boolean; userId?: string; email?: string | null; phone?: string | null; name?: string | null };

function accountFromSession(body: SessionBody): Account {
  return {
    name: typeof body.name === "string" && body.name.length > 0 ? body.name : null,
    email: typeof body.email === "string" && body.email.length > 0 ? body.email : null,
    phone: typeof body.phone === "string" && body.phone.length > 0 ? body.phone : null,
  };
}

async function loadAccount(): Promise<Account | null> {
  try {
    const response = await fetch(apiUrl("/api/auth/session"), { credentials: "include" });
    if (!response.ok) return null;
    return accountFromSession((await response.json()) as SessionBody);
  } catch {
    return null;
  }
}

function StageTitle({ screen, conversation, siteAgent }: { screen: Screen; conversation: Conversation | null; siteAgent: AgentId }) {
  switch (screen.kind) {
    case "home":
      return <AgentTitle agent={siteAgent} label={siteAgent === "main" ? "Scout" : agentById(siteAgent).name} />;
    case "tasks":
      return <h1>Tasks</h1>;
    case "settings":
      return <h1>Settings</h1>;
    case "chat": {
      if (conversation == null) return <h1>Scout</h1>;
      const label = conversation.title === "New chat" ? agentById(conversation.agent).name : conversation.title;
      return <AgentTitle agent={conversation.agent} label={label} />;
    }
    default: {
      const neverScreen: never = screen;
      return neverScreen;
    }
  }
}

function AgentTitle({ agent, label }: { agent: AgentId; label: string }) {
  const Icon = agentById(agent).icon;
  return (
    <h1 className="agent-title">
      <Icon size={18} aria-hidden="true" />
      <span>{label}</span>
    </h1>
  );
}

function Transcript({
  conversation,
  filter,
  busy,
  onFilter,
  onConfirm,
  onBook,
}: {
  conversation: Conversation;
  filter: CardFilter;
  busy: boolean;
  onFilter: (filter: CardFilter) => void;
  onConfirm: (quoteId: string) => void;
  onBook: (listing: Listing) => void;
}) {
  const cards = conversation.turns.filter((turn): turn is Extract<Turn, { kind: "card" }> => turn.kind === "card");
  const visibleCards = cards.filter((turn) => matchesCardFilter(turn.listing.kind, filter));
  const counts = filterCounts(cards.map((turn) => turn.listing), FILTERS.map((item) => item.id));
  return (
    <div className="thread">
      {conversation.agent === "event" && cards.length > 0 ? (
        <div className="filters" role="group" aria-label="Categories">
          {FILTERS.filter((item) => item.id === "all" || item.id === filter || counts[item.id] > 0).map((item) => (
            <button
              className={filter === item.id ? "chip on" : "chip"}
              type="button"
              key={item.id}
              aria-pressed={filter === item.id}
              onClick={() => onFilter(item.id)}
            >
              {item.label}
              <span className="chip-count">{counts[item.id]}</span>
            </button>
          ))}
        </div>
      ) : null}
      {conversation.turns.map((turn, index) => {
        const lastThinking = conversation.turns.findLastIndex((item) => item.kind === "thinking");
        const steps = turn.kind === "thinking" && index === lastThinking && conversation.activity.length > 0
          ? conversation.activity
          : null;
        return (
          <TurnView key={`${turn.kind}-${index}`} turn={turn} steps={steps} filter={filter} busy={busy} onConfirm={onConfirm} onBook={onBook} />
        );
      })}
      {conversation.agent === "event" && cards.length > 0 && visibleCards.length === 0 ? (
        <p className="plain">Nothing in that category. Try another filter.</p>
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

function TurnView({
  turn,
  steps,
  filter,
  busy,
  onConfirm,
  onBook,
}: {
  turn: Turn;
  steps: readonly string[] | null;
  filter: CardFilter;
  busy: boolean;
  onConfirm: (quoteId: string) => void;
  onBook: (listing: Listing) => void;
}) {
  switch (turn.kind) {
    case "user":
      return <p className="user">{turn.text}</p>;
    case "text":
      return <p className="reply">{withEmoji(turn.text)}</p>;
    case "note":
      return <p className="note">{turn.text}</p>;
    case "thinking":
      return <Thinking steps={steps && steps.length > 0 ? steps : turn.steps} startedAt={turn.startedAt} finishedAt={turn.finishedAt} />;
    case "card":
      if (!matchesCardFilter(turn.listing.kind, filter)) return null;
      return <EventCard listing={turn.listing} busy={busy} onBook={onBook} />;
    case "cart":
      return <CartCard cart={turn.cart} />;
    case "quote":
      return <QuoteCard quote={turn.quote} busy={busy} onConfirm={onConfirm} />;
    case "receipt":
      return <ReceiptCard receipt={turn.receipt} />;
    case "pay":
      return <PayCard pay={turn.pay} />;
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

function applyQuestion(turns: Turn[], message: string): Turn[] {
  let lastUser = -1;
  for (let index = 0; index < turns.length; index += 1) {
    if (turns[index]?.kind === "user") lastUser = index;
  }
  const kept = turns.filter((turn, index) => turn.kind !== "text" || index < lastUser);
  if (message.trim().length === 0) return kept;
  return [...kept, { kind: "text", text: message }];
}

function applyDrive(turns: Turn[], url: string, minutes: number): Turn[] {
  if (!Number.isFinite(minutes) || minutes <= 0) return turns;
  return turns.map((turn) => {
    if (turn.kind !== "card" || turn.listing.url !== url) return turn;
    return { ...turn, listing: { ...turn.listing, driveMinutes: minutes } };
  });
}

function turnsFrom(event: ChatEvent): Turn[] {
  switch (event.type) {
    case "question":
      return [{ kind: "text", text: event.message }];
    case "status":
      return [];
    case "source":
      return event.ok ? [] : [{ kind: "note", text: event.message }];
    case "card":
      return [{ kind: "card", listing: event.listing }];
    case "note":
      return [{ kind: "note", text: event.message }];
    case "cart":
      return [{ kind: "cart", cart: event.cart }];
    case "quote":
      return [{ kind: "quote", quote: event.quote }];
    case "receipt":
      return [{ kind: "receipt", receipt: event.receipt }];
    case "pay":
      return [{ kind: "pay", pay: event.pay }];
    case "drive":
    case "device":
    case "watch":
      return [];
    case "done":
      return [];
    default: {
      const neverEvent: never = event;
      return neverEvent;
    }
  }
}

function turnsFromCommerce(event: CommerceEvent): Turn[] {
  switch (event.type) {
    case "text":
      return [{ kind: "text", text: event.message }];
    case "note":
      return [{ kind: "note", text: event.message }];
    case "cart":
      return [{ kind: "cart", cart: event.cart }];
    case "quote":
      return [{ kind: "quote", quote: event.quote }];
    case "receipt":
      return [{ kind: "receipt", receipt: event.receipt }];
    case "pay":
      return [{ kind: "pay", pay: event.pay }];
    case "status":
    case "done":
      return [];
    default: {
      const neverEvent: never = event;
      return neverEvent;
    }
  }
}

function activityFromCommerce(event: CommerceEvent): string | null {
  switch (event.type) {
    case "status":
      return event.message;
    case "text":
    case "note":
    case "cart":
    case "quote":
    case "receipt":
    case "pay":
    case "done":
      return null;
    default: {
      const neverEvent: never = event;
      return neverEvent;
    }
  }
}

function isBrowserControl(value: { ref: string; role: string; name: string }): value is BrowserControl {
  return value.ref.trim().length > 0;
}

function browserStep(event: BrowserTaskEvent): string | null {
  switch (event.type) {
    case "status":
    case "error":
      return event.message;
    case "snapshot":
      return `The page has ${event.elements.length} controls.`;
    case "done":
      return null;
    default: {
      const neverEvent: never = event;
      return neverEvent;
    }
  }
}

function beginThinking(turns: Turn[], steps: string[] = [], now = Date.now()): Turn[] {
  return [...turns, { kind: "thinking", steps, startedAt: now, finishedAt: null }];
}

function noteThought(turns: Turn[], step: string): Turn[] {
  const index = openThinkingIndex(turns);
  const turn = index < 0 ? null : turns[index];
  if (turn == null || turn.kind !== "thinking") return turns;
  const next = appendThought(turn, step);
  if (next === turn) return turns;
  return turns.map((item, itemIndex) => (itemIndex === index ? next : item));
}

function sealThinking(turns: Turn[], now = Date.now()): Turn[] {
  const index = openThinkingIndex(turns);
  const turn = index < 0 ? null : turns[index];
  if (turn == null || turn.kind !== "thinking") return turns;
  const next = finishThought(turn, now);
  if (next === turn) return turns;
  return turns.map((item, itemIndex) => (itemIndex === index ? next : item));
}

function traceTurns(turns: Turn[], extra: Turn[], step: string | null, seal: boolean): Turn[] {
  const withExtra = extra.length > 0 ? [...turns, ...extra] : turns;
  const withStep = step ? noteThought(withExtra, step) : withExtra;
  return seal ? sealThinking(withStep) : withStep;
}

function openThinkingIndex(turns: readonly Turn[]): number {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.kind === "thinking" && turn.finishedAt == null) return index;
    if (turn?.kind === "user") return -1;
  }
  return -1;
}

function activityFrom(event: ChatEvent): string | null {
  switch (event.type) {
    case "status":
    case "source":
      return event.message;
    case "question":
    case "card":
    case "note":
    case "cart":
    case "quote":
    case "receipt":
    case "pay":
    case "drive":
    case "device":
    case "watch":
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
