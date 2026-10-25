export type NormalizedAddress = {
  formattedAddress: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  placeId: string | null;
  house: string;
  street: string;
  locality: string;
  landmark: string;
  postalCode: string;
  provider: string;
};

export type AddressDraft = {
  label: string;
  formattedAddress: string;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  placeId: string | null;
  house: string;
  street: string;
  locality: string;
  landmark: string;
  postalCode: string;
  isDefault: boolean;
};

export type SavedAddress = AddressDraft & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export function composeAddress(parts: Pick<AddressDraft, "house" | "street" | "locality" | "landmark" | "postalCode">): string {
  return [parts.house, parts.street, parts.locality, parts.landmark, parts.postalCode]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(", ");
}

export function parseAddressDraft(value: unknown): { ok: true; draft: AddressDraft } | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "Send the address to save." };
  const body = value as Record<string, unknown>;
  const label = readText(body.label, 40);
  const house = readText(body.house, 120);
  const street = readText(body.street, 120);
  const locality = readText(body.locality, 120);
  const landmark = readText(body.landmark, 120);
  const postalCode = readText(body.postalCode, 12);
  if (label === "bad" || house === "bad" || street === "bad" || locality === "bad" || landmark === "bad" || postalCode === "bad") {
    return { ok: false, error: "Address fields must be text." };
  }
  if (label.length === 0) return { ok: false, error: "Name this address, for example Home." };
  if (postalCode.length > 0 && !/^[A-Za-z0-9 -]{2,12}$/.test(postalCode)) {
    return { ok: false, error: "The postal code is not usable." };
  }
  const latitude = readOptionalCoordinate(body.latitude, -90, 90);
  const longitude = readOptionalCoordinate(body.longitude, -180, 180);
  if (latitude === "bad" || longitude === "bad") return { ok: false, error: "Coordinates are not a valid point." };
  if ((latitude == null) !== (longitude == null)) return { ok: false, error: "Send both latitude and longitude, or neither." };
  if (latitude == null && !/^\d{6}$/.test(postalCode)) {
    return { ok: false, error: "Add a 6-digit postal code, or use a detected location." };
  }
  const accuracyMeters = readOptionalAccuracy(body.accuracyMeters);
  if (accuracyMeters === "bad") return { ok: false, error: "Accuracy is not a usable distance." };
  const placeId = readText(body.placeId, 64);
  if (placeId === "bad") return { ok: false, error: "Address fields must be text." };
  const formatted = composeAddress({ house, street, locality, landmark, postalCode });
  if (formatted.length === 0) return { ok: false, error: "Enter enough of the address to recognise it." };
  return {
    ok: true,
    draft: {
      label,
      formattedAddress: formatted,
      latitude,
      longitude,
      accuracyMeters,
      placeId: placeId && placeId.length > 0 ? placeId : null,
      house,
      street,
      locality,
      landmark,
      postalCode,
      isDefault: body.isDefault === true,
    },
  };
}

function readText(value: unknown, max: number): string | "bad" {
  if (value == null) return "";
  if (typeof value !== "string") return "bad";
  const text = value.trim();
  if (text.length > max) return "bad";
  return text;
}

function readOptionalCoordinate(value: unknown, min: number, max: number): number | null | "bad" {
  if (value == null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return "bad";
  return value;
}

function readOptionalAccuracy(value: unknown): number | null | "bad" {
  if (value == null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100_000) return "bad";
  return value;
}
