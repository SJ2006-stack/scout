import type { DeliveryArea } from "./offer.ts";

export function deliveryAreaForSearch(input: {
  pincode: string;
  lat: number | null;
  lon: number | null;
}): DeliveryArea | null {
  const pincode = /^\d{6}$/.test(input.pincode) ? input.pincode : "";
  const point = typeof input.lat === "number" && typeof input.lon === "number";
  if (pincode.length > 0) {
    return {
      pincode,
      lat: point ? input.lat : null,
      lon: point ? input.lon : null,
      label: `Searching near pincode ${pincode}`,
      confirmed: true,
      approximate: true,
    };
  }
  if (!point || input.lat == null || input.lon == null) return null;
  return {
    pincode: "",
    lat: input.lat,
    lon: input.lon,
    label: `Searching around ${input.lat.toFixed(2)}, ${input.lon.toFixed(2)}`,
    confirmed: true,
    approximate: true,
  };
}
