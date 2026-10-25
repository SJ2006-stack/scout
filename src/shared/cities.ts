export type City = {
  id: string;
  name: string;
  lumaSlug: string;
  bookMyShowCity: string;
  aliases: string[];
  pincodePrefix: string;
};

export const CITIES: City[] = [
  { id: "bengaluru", name: "Bengaluru", lumaSlug: "bengaluru", bookMyShowCity: "Bengaluru", aliases: ["bengaluru", "bangalore"], pincodePrefix: "560" },
  { id: "mumbai", name: "Mumbai", lumaSlug: "mumbai", bookMyShowCity: "Mumbai", aliases: ["mumbai"], pincodePrefix: "400" },
  { id: "delhi", name: "Delhi", lumaSlug: "new-delhi", bookMyShowCity: "Delhi-NCR", aliases: ["delhi", "new delhi"], pincodePrefix: "110" },
  { id: "hyderabad", name: "Hyderabad", lumaSlug: "hyderabad", bookMyShowCity: "Hyderabad", aliases: ["hyderabad"], pincodePrefix: "500" },
];

export function cityById(id: string | null): City | null {
  if (id == null) return null;
  return CITIES.find((city) => city.id === id) ?? null;
}

export function cityFromText(text: string): City | null {
  const value = text.toLowerCase();
  const ranked = [...CITIES].sort((left, right) => {
    const leftAlias = Math.max(...left.aliases.map((alias) => alias.length));
    const rightAlias = Math.max(...right.aliases.map((alias) => alias.length));
    return rightAlias - leftAlias;
  });
  for (const city of ranked) {
    if (city.aliases.some((alias) => value.includes(alias))) return city;
  }
  return null;
}

export function cityFromPincode(pincode: string): City | null {
  if (!/^\d{6}$/.test(pincode)) return null;
  return CITIES.find((city) => pincode.startsWith(city.pincodePrefix)) ?? null;
}

export function cityMatches(place: string | null, city: City): boolean {
  if (place == null || place.trim().length === 0) return false;
  const value = place.toLowerCase();
  return city.aliases.some((alias) => value.includes(alias));
}
