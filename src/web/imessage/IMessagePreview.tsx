import "./imessage.css";

type Scheme = "light" | "dark";
type Service = "imessage" | "sms" | "rcs";
type Side = "in" | "out";

type Piece =
  | { kind: "text"; from: string; text: string; reaction?: string }
  | { kind: "photo"; from: string }
  | { kind: "voice"; from: string }
  | { kind: "link"; from: string }
  | { kind: "typing"; from: string };

type Person = { id: string; name: string; color: string; initial: string };

type Variation = {
  id: string;
  title: string;
  note: string;
  scheme: Scheme;
  service: Service;
  glass: boolean;
  screen: "thread" | "inbox";
  people: Person[];
  pieces: Piece[];
  receipt?: string;
  effect?: boolean;
};

const priya: Person = { id: "priya", name: "Priya", color: "#8e8e93", initial: "P" };
const me: Person = { id: "me", name: "You", color: "#ff3b30", initial: "Y" };
const maya: Person = { id: "maya", name: "Maya", color: "#ff2d55", initial: "M" };
const arun: Person = { id: "arun", name: "Arun", color: "#ff9500", initial: "A" };
const leela: Person = { id: "leela", name: "Leela", color: "#af52de", initial: "L" };

const dinner: Piece[] = [
  { kind: "text", from: "priya", text: "You around tonight?" },
  { kind: "text", from: "me", text: "Yeah, after 8" },
  { kind: "text", from: "me", text: "Want to get dinner?" },
  { kind: "text", from: "priya", text: "Primrose?" },
  { kind: "text", from: "me", text: "Done. I'll book it." },
];

const variations: Variation[] = [
  {
    id: "light-imessage",
    title: "Light · iMessage",
    note: "Red bubbles, gray replies, Read under the last one you sent.",
    scheme: "light",
    service: "imessage",
    glass: true,
    screen: "thread",
    people: [priya, me],
    pieces: dinner,
    receipt: "Read",
  },
  {
    id: "dark-imessage",
    title: "Dark · iMessage",
    note: "Same thread. Incoming bubbles go charcoal, red gets brighter.",
    scheme: "dark",
    service: "imessage",
    glass: true,
    screen: "thread",
    people: [priya, me],
    pieces: dinner,
    receipt: "Read",
  },
  {
    id: "classic-light",
    title: "Light · classic chrome",
    note: "The same red thread with solid bars instead of frosted glass.",
    scheme: "light",
    service: "imessage",
    glass: false,
    screen: "thread",
    people: [priya, me],
    pieces: dinner,
    receipt: "Read",
  },
  {
    id: "classic-dark",
    title: "Dark · classic chrome",
    note: "Solid dark bars, no blur behind the name or the composer.",
    scheme: "dark",
    service: "imessage",
    glass: false,
    screen: "thread",
    people: [priya, me],
    pieces: dinner,
    receipt: "Read",
  },
  {
    id: "light-sms",
    title: "Light · SMS",
    note: "Red bubbles. The field says Text Message. Delivered, not Read.",
    scheme: "light",
    service: "sms",
    glass: true,
    screen: "thread",
    people: [priya, me],
    pieces: dinner,
    receipt: "Delivered",
  },
  {
    id: "dark-sms",
    title: "Dark · SMS",
    note: "Red on black. Still a text message, not an iMessage.",
    scheme: "dark",
    service: "sms",
    glass: true,
    screen: "thread",
    people: [priya, me],
    pieces: dinner,
    receipt: "Delivered",
  },
  {
    id: "light-rcs",
    title: "Light · RCS",
    note: "Red as well, with a tapback, a typing bubble, and a field that says RCS.",
    scheme: "light",
    service: "rcs",
    glass: true,
    screen: "thread",
    people: [priya, me],
    pieces: [
      { kind: "text", from: "priya", text: "Leaving now", reaction: "👍" },
      { kind: "text", from: "me", text: "Gate 2?" },
      { kind: "typing", from: "priya" },
    ],
  },
  {
    id: "dark-rcs",
    title: "Dark · RCS",
    note: "Same RCS thread after dark mode.",
    scheme: "dark",
    service: "rcs",
    glass: true,
    screen: "thread",
    people: [priya, me],
    pieces: [
      { kind: "text", from: "priya", text: "Leaving now", reaction: "👍" },
      { kind: "text", from: "me", text: "Gate 2?" },
      { kind: "typing", from: "priya" },
    ],
  },
  {
    id: "group-light",
    title: "Light · group",
    note: "Names in their own colors, a face only on the last bubble of a run.",
    scheme: "light",
    service: "imessage",
    glass: true,
    screen: "thread",
    people: [maya, arun, leela, me],
    pieces: [
      { kind: "text", from: "maya", text: "Who's in for Friday?" },
      { kind: "text", from: "arun", text: "I'm in" },
      { kind: "text", from: "me", text: "Same" },
      { kind: "text", from: "me", text: "I'll grab the table" },
      { kind: "text", from: "leela", text: "Save me a seat" },
    ],
    receipt: "Delivered",
  },
  {
    id: "group-dark",
    title: "Dark · group",
    note: "Same group, dark canvas.",
    scheme: "dark",
    service: "imessage",
    glass: true,
    screen: "thread",
    people: [maya, arun, leela, me],
    pieces: [
      { kind: "text", from: "maya", text: "Who's in for Friday?" },
      { kind: "text", from: "arun", text: "I'm in" },
      { kind: "text", from: "me", text: "Same" },
      { kind: "text", from: "me", text: "I'll grab the table" },
      { kind: "text", from: "leela", text: "Save me a seat" },
    ],
    receipt: "Delivered",
  },
  {
    id: "tapbacks",
    title: "Tapbacks",
    note: "Heart, ha ha, emphasis. They sit on the corner toward the middle.",
    scheme: "light",
    service: "imessage",
    glass: true,
    screen: "thread",
    people: [priya, me],
    pieces: [
      { kind: "text", from: "priya", text: "The photos are so good", reaction: "❤️" },
      { kind: "text", from: "me", text: "Right??", reaction: "😂" },
      { kind: "text", from: "priya", text: "Sending the rest", reaction: "‼️" },
    ],
  },
  {
    id: "attachments",
    title: "Photo, voice, link",
    note: "A picture with no bubble fill, a memo, and a link card.",
    scheme: "light",
    service: "imessage",
    glass: true,
    screen: "thread",
    people: [priya, me],
    pieces: [
      { kind: "photo", from: "me" },
      { kind: "text", from: "priya", text: "Okay this one" },
      { kind: "voice", from: "priya" },
      { kind: "link", from: "me" },
    ],
    receipt: "Delivered",
  },
  {
    id: "typing",
    title: "Typing",
    note: "Three dots in a gray bubble while you wait.",
    scheme: "light",
    service: "imessage",
    glass: true,
    screen: "thread",
    people: [priya, me],
    pieces: [
      { kind: "text", from: "me", text: "Did you see it?" },
      { kind: "typing", from: "priya" },
    ],
  },
  {
    id: "balloons",
    title: "Screen effect",
    note: "Balloons fill the thread for a moment after a send. They do not stay.",
    scheme: "light",
    service: "imessage",
    glass: true,
    screen: "thread",
    people: [priya, me],
    pieces: [
      { kind: "text", from: "me", text: "We're going" },
      { kind: "text", from: "priya", text: "Finally" },
    ],
    effect: true,
  },
  {
    id: "inbox-light",
    title: "Inbox · light",
    note: "The list. Unread names are bold. Filters sit under the title.",
    scheme: "light",
    service: "imessage",
    glass: false,
    screen: "inbox",
    people: [],
    pieces: [],
  },
  {
    id: "inbox-dark",
    title: "Inbox · dark",
    note: "The same list in dark mode.",
    scheme: "dark",
    service: "imessage",
    glass: false,
    screen: "inbox",
    people: [],
    pieces: [],
  },
];

const inboxRows = [
  { name: "Priya", initial: "P", color: "#8e8e93", preview: "Primrose?", time: "9:41 PM", unread: true },
  { name: "Friday dinner", initial: "F", color: "#ff2d55", preview: "Leela: Save me a seat", time: "8:12 PM", unread: true },
  { name: "Arun", initial: "A", color: "#ff9500", preview: "Delivered", time: "Yesterday", unread: false },
  { name: "Maya", initial: "M", color: "#ff3b30", preview: "Text Message", time: "Tuesday", unread: false },
  { name: "Leela", initial: "L", color: "#af52de", preview: "Okay send it", time: "Monday", unread: false },
];

function personById(people: Person[], id: string): Person {
  const found = people.find((person) => person.id === id);
  if (!found) throw new Error(`Unknown person ${id}`);
  return found;
}

function sideOf(id: string): Side {
  return id === "me" ? "out" : "in";
}

function placeholder(service: Service): string {
  switch (service) {
    case "imessage":
      return "iMessage";
    case "sms":
      return "Text Message";
    case "rcs":
      return "RCS Message";
    default: {
      const never: never = service;
      return never;
    }
  }
}

function Tail({ side }: { side: Side }) {
  return (
    <svg className={`tail ${side}`} viewBox="0 0 18 20" aria-hidden="true">
      <path fill="currentColor" d="M18 20H2c3.2 0 6.2-1.6 8.2-6.2C12.4 8.6 13.6 4 18 0v20z" />
    </svg>
  );
}

function BubbleBody({ piece }: { piece: Piece }) {
  switch (piece.kind) {
    case "text":
      return piece.text;
    case "photo":
      return <div className="photo" />;
    case "voice":
      return (
        <div className="voice">
          <span className="play">▶</span>
          <span className="wave">
            {[8, 14, 10, 16, 7, 12, 18, 9, 13, 6].map((height, bar) => (
              <i key={bar} style={{ height }} />
            ))}
          </span>
          <span>0:12</span>
        </div>
      );
    case "link":
      return null;
    case "typing":
      return (
        <span className="typing">
          <i />
          <i />
          <i />
        </span>
      );
    default: {
      const never: never = piece;
      return never;
    }
  }
}

function ThreadScreen({ variation }: { variation: Variation }) {
  const title = variation.people.length > 2 ? "Friday dinner" : variation.people[0]?.name ?? "Messages";
  return (
    <>
      <header className="nav">
        <span className="back">‹ 12</span>
        <div className="who">
          <div className="avatar" style={{ background: variation.people[0]?.color ?? "#8e8e93" }}>
            {variation.people.length > 2 ? "3" : variation.people[0]?.initial}
          </div>
          <strong>{title}</strong>
        </div>
        <span className="nav-actions">
          <VideoIcon />
        </span>
      </header>
      <div className="thread">
        <div className="stamp">Today 9:41 PM</div>
        {variation.pieces.map((piece, index) => {
          const previous = variation.pieces[index - 1];
          const next = variation.pieces[index + 1];
          const sameBefore = previous?.from === piece.from;
          const tail = next?.from !== piece.from;
          const person = personById(variation.people, piece.from);
          const side = sideOf(piece.from);
          const showName = variation.people.length > 2 && side === "in" && !sameBefore && piece.kind === "text";
          if (piece.kind === "link") {
            return (
              <div className={`row ${side} ${sameBefore ? "same" : "swap"}`} key={`${piece.kind}-${index}`}>
                <div className="link-card">
                  <div className="shot" />
                  <div>
                    <strong>Primrose</strong>
                    <span>Menu · indirapuram</span>
                  </div>
                </div>
              </div>
            );
          }
          return (
            <div className={`row ${side} ${sameBefore ? "same" : "swap"}`} key={`${piece.kind}-${index}`}>
              {variation.people.length > 2 && side === "in" ? (
                <div className="gutter">
                  {tail ? (
                    <div className="mini" style={{ background: person.color }}>
                      {person.initial}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="stack">
                {showName ? (
                  <span className="sender" style={{ color: person.color }}>
                    {person.name}
                  </span>
                ) : null}
                <div className={`bubble ${side} ${tail ? "has-tail" : ""} ${piece.kind === "photo" ? "photo-bubble" : ""}`} style={piece.kind === "photo" ? { padding: 0, background: "transparent" } : undefined}>
                  <BubbleBody piece={piece} />
                  {piece.kind === "text" && piece.reaction ? <span className="reaction">{piece.reaction}</span> : null}
                  {tail && piece.kind !== "photo" ? <Tail side={side} /> : null}
                </div>
              </div>
            </div>
          );
        })}
        {variation.receipt ? <div className="receipt">{variation.receipt}</div> : null}
      </div>
      {variation.effect ? <div className="balloons" /> : null}
      <form className="composer" action="#" onSubmit={(event) => event.preventDefault()}>
        <span className="plus">+</span>
        <span className="field">{placeholder(variation.service)}</span>
        <span className="mic">
          <MicIcon />
        </span>
      </form>
    </>
  );
}

function InboxScreen() {
  return (
    <div className="inbox">
      <div className="inbox-bar">
        <span>Edit</span>
        <ComposeIcon />
      </div>
      <h3>Messages</h3>
      <div className="filters">
        <span className="on">All</span>
        <span>Known</span>
        <span>Unknown</span>
      </div>
      <div className="search">Search</div>
      {inboxRows.map((row) => (
        <div className="thread-row" key={row.name}>
          <div className="face" style={{ background: row.color }}>
            {row.initial}
          </div>
          <div className={row.unread ? "unread" : ""}>
            <strong>{row.name}</strong>
            <em>{row.preview}</em>
          </div>
          <time>{row.time}</time>
        </div>
      ))}
    </div>
  );
}

function Phone({ variation }: { variation: Variation }) {
  return (
    <div className="phone" data-scheme={variation.scheme} data-service={variation.service} data-glass={variation.glass ? "1" : "0"}>
      <div className="screen">
        <div className="status">
          <span>9:41</span>
          <span className="status-icons">
            <SignalIcon />
            <WifiIcon />
            <BatteryIcon />
          </span>
        </div>
        <div className="island" />
        {variation.screen === "inbox" ? <InboxScreen /> : <ThreadScreen variation={variation} />}
      </div>
    </div>
  );
}

export function IMessagePreview() {
  return (
    <div className="imsg-page">
      <header className="imsg-head">
        <h1>iMessage</h1>
        <p className="imsg-lead">
          Local lookbook of the chat screens. Every accent is red, including SMS and RCS. Group, tapback, attachment, typing, and inbox are the other screens.
        </p>
      </header>
      <div className="imsg-wall">
        {variations.map((variation) => (
          <section className="imsg-card" key={variation.id}>
            <h2>{variation.title}</h2>
            <p>{variation.note}</p>
            <Phone variation={variation} />
          </section>
        ))}
      </div>
    </div>
  );
}

function SignalIcon() {
  return (
    <svg width="15" height="10" viewBox="0 0 15 10" aria-hidden="true">
      <rect x="0" y="6" width="2.2" height="4" rx="0.4" fill="currentColor" />
      <rect x="3.2" y="4" width="2.2" height="6" rx="0.4" fill="currentColor" />
      <rect x="6.4" y="2" width="2.2" height="8" rx="0.4" fill="currentColor" />
      <rect x="9.6" y="0" width="2.2" height="10" rx="0.4" fill="currentColor" />
    </svg>
  );
}

function WifiIcon() {
  return (
    <svg width="13" height="10" viewBox="0 0 13 10" aria-hidden="true">
      <path fill="currentColor" d="M6.5 8.2a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2zM6.5 4.6c1.5 0 2.8.6 3.8 1.5l-1 1.1A4 4 0 0 0 6.5 6a4 4 0 0 0-2.8 1.2l-1-1.1A5.4 5.4 0 0 1 6.5 4.6zM6.5 1.4c2.4 0 4.6 1 6.2 2.6l-1 1A7.4 7.4 0 0 0 6.5 3a7.4 7.4 0 0 0-5.2 2l-1-1A9 9 0 0 1 6.5 1.4z" />
    </svg>
  );
}

function BatteryIcon() {
  return (
    <svg width="22" height="10" viewBox="0 0 22 10" aria-hidden="true">
      <rect x="0.5" y="0.5" width="18" height="9" rx="2" fill="none" stroke="currentColor" />
      <rect x="2" y="2" width="13" height="6" rx="1" fill="currentColor" />
      <rect x="19.5" y="3" width="1.6" height="4" rx="0.5" fill="currentColor" />
    </svg>
  );
}

function VideoIcon() {
  return (
    <svg width="20" height="14" viewBox="0 0 20 14" aria-hidden="true">
      <rect x="0.5" y="1" width="12" height="12" rx="2" fill="none" stroke="currentColor" />
      <path d="M14 5.2 19 3v8l-5-2.2V5.2z" fill="currentColor" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="12" height="16" viewBox="0 0 12 16" aria-hidden="true">
      <rect x="3" y="0.5" width="6" height="9" rx="3" fill="none" stroke="currentColor" />
      <path d="M1.5 7.5a4.5 4.5 0 0 0 9 0M6 12v3" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function ComposeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <rect x="2" y="2" width="14" height="14" rx="3" fill="none" stroke="currentColor" />
      <path d="M6 12.5 12.5 6l1 1L7 13.5H6v-1z" fill="currentColor" />
    </svg>
  );
}
