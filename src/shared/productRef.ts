export type ShopApp = "blinkit" | "zepto" | "instamart";
export type ProductRef = { store: ShopApp; productId: string | null; link: string | null; name: string; size: string | null; price: number; seenAt: number };
export type EventApp = "bookmyshow" | "district" | "luma";
export type EventRef = { app: EventApp; eventId: string | null; link: string; title: string; venue: string | null; startsAt: number | null; price: number | null };
