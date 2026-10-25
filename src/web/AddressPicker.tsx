import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { NormalizedAddress, SavedAddress } from "../shared/address.ts";
import { parseAddressDraft } from "../shared/address.ts";
import {
  LOCATION_SESSION_KEY,
  parseLocationSession,
  requestBrowserLocation,
  type LocationFailure,
  type LocationFix,
} from "./locationSession.ts";
import { apiUrl, backendHeaders } from "./backend.ts";

export type UsedArea = {
  lat: number | null;
  lon: number | null;
  pincode: string;
  accuracyMeters: number | null;
  detectedAt: number | null;
};

type DraftState = {
  label: string;
  house: string;
  street: string;
  locality: string;
  landmark: string;
  postalCode: string;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  placeId: string | null;
  detectedAt: number | null;
  suggestion: string;
};

type Mode =
  | { kind: "idle" }
  | { kind: "locating" }
  | { kind: "geocoding" }
  | { kind: "draft"; draft: DraftState; editingId: string | null }
  | { kind: "error"; message: string };

export function AddressPicker({ onUse }: { onUse: (area: UsedArea) => void }) {
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [saved, setSaved] = useState<SavedAddress[]>([]);
  const [status, setStatus] = useState("Use your current location, or enter an address manually.");

  useEffect(() => {
    void loadSaved(setSaved, setStatus);
  }, []);

  async function locate(fresh: boolean): Promise<void> {
    setMode({ kind: "locating" });
    setStatus("Reading this device's location…");
    const recent = recentFix();
    const result = await requestBrowserLocation({ fresh, recent, now: Date.now() });
    if (!result.ok) {
      setMode({ kind: "error", message: failureMessage(result.failure) });
      setStatus(failureMessage(result.failure));
      return;
    }
    setMode({ kind: "geocoding" });
    setStatus(result.reused ? "Using the location read a few minutes ago. Looking up the address…" : "Looking up an address for this point…");
    const response = await fetch(apiUrl("/api/location/reverse-geocode"), {
      method: "POST",
      headers: backendHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        latitude: result.fix.lat,
        longitude: result.fix.lon,
        accuracyMeters: result.fix.accuracyMeters,
      }),
    });
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      const message = payload.error ?? "No address was found for that point. Enter it manually.";
      setMode({ kind: "draft", draft: emptyDraft(result.fix), editingId: null });
      setStatus(message);
      return;
    }
    const address = (await response.json()) as NormalizedAddress;
    setMode({ kind: "draft", draft: draftFromAddress(address, result.fix), editingId: null });
    setStatus(previewStatus(result.fix.accuracyMeters));
  }

  function useDraft(draft: DraftState): void {
    if (!canUse(draft)) {
      setStatus("Add a 6-digit postal code, or detect a location, before confirming.");
      return;
    }
    onUse({
      lat: draft.latitude,
      lon: draft.longitude,
      pincode: /^\d{6}$/.test(draft.postalCode) ? draft.postalCode : "",
      accuracyMeters: draft.accuracyMeters,
      detectedAt: draft.detectedAt,
    });
    setStatus("This address is confirmed for the search. It is only as complete as the fields you checked.");
  }

  async function saveDraft(event: FormEvent, draft: DraftState, editingId: string | null): Promise<void> {
    event.preventDefault();
    const parsed = parseAddressDraft(draft);
    if (!parsed.ok) {
      setStatus(parsed.error);
      return;
    }
    const response = await fetch(apiUrl(editingId ? `/api/addresses/${editingId}` : "/api/addresses"), {
      method: editingId ? "PATCH" : "POST",
      headers: backendHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(parsed.draft),
    });
    const payload = (await response.json()) as { error?: string };
    if (!response.ok) {
      setStatus(payload.error ?? "The address could not be saved.");
      return;
    }
    useDraft(draft);
    setStatus("Saved for this browser session. Restarting Scout clears saved addresses.");
    await loadSaved(setSaved, setStatus);
  }

  return (
    <section className="area" aria-label="Delivery address" aria-busy={mode.kind === "locating" || mode.kind === "geocoding"}>
      <div className="row">
        <button type="button" onClick={() => void locate(false)} disabled={mode.kind === "locating" || mode.kind === "geocoding"}>
          Use my current location
        </button>
        <button
          className="secondary"
          type="button"
          onClick={() => {
            setMode({ kind: "draft", draft: emptyDraft(null), editingId: null });
            setStatus("Enter the address yourself. A detected point is not required.");
          }}
        >
          Enter an address manually
        </button>
        {mode.kind === "error" ? (
          <button className="secondary" type="button" onClick={() => void locate(true)}>
            Try again
          </button>
        ) : null}
      </div>
      <p className="note" aria-live="polite">{status}</p>
      {mode.kind === "draft" ? (
        <AddressForm
          draft={mode.draft}
          editing={mode.editingId != null}
          onChange={(draft) => setMode({ kind: "draft", draft, editingId: mode.editingId })}
          onUse={() => useDraft(mode.draft)}
          onSave={(event) => void saveDraft(event, mode.draft, mode.editingId)}
        />
      ) : null}
      {saved.length > 0 ? (
        <ul className="saved">
          {saved.map((address) => (
            <li key={address.id}>
              <span>
                {address.label}
                {address.isDefault ? " · Default" : ""}
                {` · ${address.formattedAddress}`}
              </span>
              <div className="row">
                <button type="button" className="secondary" onClick={() => useDraft(draftFromSaved(address))}>
                  Use for search
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setMode({ kind: "draft", draft: draftFromSaved(address), editingId: address.id });
                    setStatus("Check the fields, then save the edit.");
                  }}
                >
                  Edit
                </button>
                {address.isDefault ? null : (
                  <button type="button" className="secondary" onClick={() => void makeDefault(address.id, setSaved, setStatus)}>
                    Make default
                  </button>
                )}
                <button type="button" className="secondary" onClick={() => void removeAddress(address.id, setSaved, setStatus)}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="hint">Address lookup uses OpenStreetMap Nominatim. A suggested address is not a verified delivery point.</p>
    </section>
  );
}

function AddressForm({
  draft,
  editing,
  onChange,
  onUse,
  onSave,
}: {
  draft: DraftState;
  editing: boolean;
  onChange: (draft: DraftState) => void;
  onUse: () => void;
  onSave: (event: FormEvent) => void;
}) {
  function field(key: "label" | "house" | "street" | "locality" | "landmark" | "postalCode", value: string): void {
    const next = key === "postalCode" ? value.replace(/[^\dA-Za-z -]/g, "").slice(0, 12) : value;
    onChange({ ...draft, [key]: next });
  }

  return (
    <form className="fields" onSubmit={onSave}>
      {draft.suggestion ? <p className="note">Suggested: {draft.suggestion}</p> : null}
      {draft.accuracyMeters != null ? (
        <p className="note">The device reports this point within about {Math.round(draft.accuracyMeters)} m.</p>
      ) : null}
      <label>
        Name
        <input value={draft.label} onChange={(event) => field("label", event.target.value)} />
      </label>
      <label>
        House or building
        <input value={draft.house} onChange={(event) => field("house", event.target.value)} />
      </label>
      <label>
        Street
        <input value={draft.street} onChange={(event) => field("street", event.target.value)} />
      </label>
      <label>
        Locality
        <input value={draft.locality} onChange={(event) => field("locality", event.target.value)} />
      </label>
      <label>
        Landmark
        <input value={draft.landmark} onChange={(event) => field("landmark", event.target.value)} />
      </label>
      <label>
        Postal code
        <input inputMode="numeric" autoComplete="postal-code" value={draft.postalCode} onChange={(event) => field("postalCode", event.target.value)} />
      </label>
      <div className="row">
        <button type="button" onClick={onUse}>
          Use this address
        </button>
        <button className="secondary" type="submit">
          {editing ? "Save changes" : "Save address"}
        </button>
      </div>
    </form>
  );
}

async function loadSaved(
  setSaved: (addresses: SavedAddress[]) => void,
  setStatus: (message: string) => void,
): Promise<void> {
  const response = await fetch(apiUrl("/api/addresses"), { headers: backendHeaders() });
  if (!response.ok) {
    setStatus("Saved addresses could not be loaded.");
    return;
  }
  const payload = (await response.json()) as { addresses?: SavedAddress[] };
  setSaved(payload.addresses ?? []);
}

async function removeAddress(
  id: string,
  setSaved: (addresses: SavedAddress[]) => void,
  setStatus: (message: string) => void,
): Promise<void> {
  const response = await fetch(apiUrl(`/api/addresses/${id}`), { method: "DELETE", headers: backendHeaders() });
  if (!response.ok && response.status !== 204) {
    setStatus("That address could not be deleted.");
    return;
  }
  setStatus("Address deleted.");
  await loadSaved(setSaved, setStatus);
}

async function makeDefault(
  id: string,
  setSaved: (addresses: SavedAddress[]) => void,
  setStatus: (message: string) => void,
): Promise<void> {
  const response = await fetch(apiUrl(`/api/addresses/${id}`), {
    method: "PATCH",
    headers: backendHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ isDefault: true }),
  });
  if (!response.ok) {
    setStatus("The default address could not be changed.");
    return;
  }
  setStatus("Default address updated for this browser session.");
  await loadSaved(setSaved, setStatus);
}

function recentFix(): LocationFix | null {
  const saved = parseLocationSession(sessionStorage.getItem(LOCATION_SESSION_KEY));
  if (!saved || saved.lat == null || saved.lon == null || saved.detectedAt == null) return null;
  return { lat: saved.lat, lon: saved.lon, accuracyMeters: saved.accuracyMeters, detectedAt: saved.detectedAt };
}

function emptyDraft(fix: LocationFix | null): DraftState {
  return {
    label: "",
    house: "",
    street: "",
    locality: "",
    landmark: "",
    postalCode: "",
    latitude: fix?.lat ?? null,
    longitude: fix?.lon ?? null,
    accuracyMeters: fix?.accuracyMeters ?? null,
    placeId: null,
    detectedAt: fix?.detectedAt ?? null,
    suggestion: "",
  };
}

function draftFromAddress(address: NormalizedAddress, fix: LocationFix): DraftState {
  return {
    label: "",
    house: address.house,
    street: address.street,
    locality: address.locality,
    landmark: address.landmark,
    postalCode: address.postalCode,
    latitude: fix.lat,
    longitude: fix.lon,
    accuracyMeters: fix.accuracyMeters,
    placeId: address.placeId,
    detectedAt: fix.detectedAt,
    suggestion: address.formattedAddress,
  };
}

function draftFromSaved(address: SavedAddress): DraftState {
  return {
    label: address.label,
    house: address.house,
    street: address.street,
    locality: address.locality,
    landmark: address.landmark,
    postalCode: address.postalCode,
    latitude: address.latitude,
    longitude: address.longitude,
    accuracyMeters: address.accuracyMeters,
    placeId: address.placeId,
    detectedAt: null,
    suggestion: address.formattedAddress,
  };
}

function canUse(draft: DraftState): boolean {
  return /^\d{6}$/.test(draft.postalCode) || (draft.latitude != null && draft.longitude != null);
}

function previewStatus(accuracyMeters: number | null): string {
  const accuracy = accuracyMeters == null ? "" : ` The device reports about ${Math.round(accuracyMeters)} m of accuracy.`;
  return `Check the suggested fields before using this address. Missing parts stay blank on purpose.${accuracy}`;
}

function failureMessage(failure: LocationFailure): string {
  switch (failure) {
    case "denied":
      return "Location permission was denied. Enter the address manually, or allow location and try again.";
    case "unavailable":
      return "This device could not determine a location. Try again, or enter the address manually.";
    case "timeout":
      return "The device took too long to report a location. Try again, or enter the address manually.";
    case "unsupported":
      return "This browser cannot share a location. Enter the address manually.";
    case "insecure":
      return "Location is only available on a secure page. Enter the address manually.";
    default: {
      const neverFailure: never = failure;
      return neverFailure;
    }
  }
}
