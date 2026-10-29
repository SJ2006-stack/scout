export type AppointmentStatus = "pending" | "confirmed" | "rejected" | "cancelled";

export type SalonService = {
  id: string;
  name: string;
  price: number | null;
  stylists: string[];
};

export type Appointment = {
  externalId: string;
  status: AppointmentStatus;
  service: string;
  time: string;
  customerName: string;
  stylist: string | null;
  price: number | null;
  provenance: "demo";
  simulated: true;
};

export type BookingRequest = {
  serviceId: string;
  time: string;
  customerName: string;
  stylist: string | null;
  clientRequestId: string;
};

export type ServicePhrase = "haircut" | "beard" | "beard trim" | "color" | "blowdry";

const SERVICES: readonly SalonService[] = [
  { id: "haircut", name: "Haircut", price: 500, stylists: ["Noor", "Asha"] },
  { id: "beard", name: "Beard trim", price: 200, stylists: ["Noor"] },
  { id: "color", name: "Color", price: null, stylists: ["Asha"] },
  { id: "blowdry", name: "Blowdry", price: 350, stylists: [] },
];

export function createMockSalon(ids: () => string): MockSalon {
  return new MockSalon(SERVICES, ids);
}

export class MockSalon {
  readonly provenance = "demo" as const;
  private readonly services: SalonService[];
  private readonly appointments = new Map<string, Appointment>();
  private readonly byClient = new Map<string, string>();
  private readonly ids: () => string;
  private created = 0;

  constructor(services: readonly SalonService[], ids: () => string) {
    this.services = services.map((service) => ({ ...service, stylists: [...service.stylists] }));
    this.ids = ids;
  }

  get createdCount(): number {
    return this.created;
  }

  search(query: string): SalonService[] {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return this.services.map(copyService);
    return this.services.filter((service) => service.name.toLowerCase().includes(needle) || service.id === needle).map(copyService);
  }

  service(serviceId: string): SalonService | null {
    const found = this.services.find((item) => item.id === serviceId);
    return found ? copyService(found) : null;
  }

  supportsStylist(serviceId: string): boolean {
    return (this.service(serviceId)?.stylists.length ?? 0) > 0;
  }

  matchStylist(serviceId: string, name: string): string | null {
    const service = this.service(serviceId);
    if (!service) return null;
    return service.stylists.find((stylist) => stylist.toLowerCase() === name.toLowerCase()) ?? null;
  }

  request(input: BookingRequest): Appointment | null {
    const existingId = this.byClient.get(input.clientRequestId);
    if (existingId) return this.appointments.get(existingId) ?? null;
    const service = this.services.find((item) => item.id === input.serviceId);
    if (!service) return null;
    this.created += 1;
    const appointment: Appointment = {
      externalId: this.ids(),
      status: "pending",
      service: service.name,
      time: input.time,
      customerName: input.customerName,
      stylist: service.stylists.length === 0 ? null : input.stylist,
      price: service.price,
      provenance: "demo",
      simulated: true,
    };
    this.appointments.set(appointment.externalId, appointment);
    this.byClient.set(input.clientRequestId, appointment.externalId);
    return appointment;
  }

  status(externalId: string): Appointment | null {
    const found = this.appointments.get(externalId);
    return found ? { ...found } : null;
  }

  script(externalId: string, decision: "confirm" | "reject"): Appointment | null {
    const current = this.appointments.get(externalId);
    if (!current || current.status !== "pending") return current ? { ...current } : null;
    const next: Appointment = { ...current, status: decision === "confirm" ? "confirmed" : "rejected" };
    this.appointments.set(externalId, next);
    return { ...next };
  }

  cancel(externalId: string): Appointment | null {
    const current = this.appointments.get(externalId);
    if (!current) return null;
    const next: Appointment = { ...current, status: "cancelled" };
    this.appointments.set(externalId, next);
    return { ...next };
  }

  setPrice(serviceId: string, price: number | null): void {
    const service = this.services.find((item) => item.id === serviceId);
    if (service) service.price = price;
  }
}

export function servicePhrase(value: string): ServicePhrase | null {
  switch (value) {
    case "haircut":
    case "beard":
    case "beard trim":
    case "color":
    case "blowdry":
      return value;
    default:
      return null;
  }
}

export function serviceIdFromPhrase(phrase: ServicePhrase): string {
  switch (phrase) {
    case "haircut":
      return "haircut";
    case "beard":
    case "beard trim":
      return "beard";
    case "color":
      return "color";
    case "blowdry":
      return "blowdry";
    default: {
      const neverPhrase: never = phrase;
      return neverPhrase;
    }
  }
}

export function readBookingPhrase(text: string): {
  service: string | null;
  time: string | null;
  customerName: string | null;
  stylist: string | null;
} {
  const service = /\b(haircut|beard trim|beard|blowdry|color)\b/i.exec(text)?.[1]?.toLowerCase() ?? null;
  const stylist = /\bwith\s+([A-Za-z]+)\b/i.exec(text)?.[1] ?? null;
  const customer = /\bfor\s+([A-Za-z]+)\b/i.exec(text)?.[1] ?? null;
  const day = /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.exec(text)?.[1] ?? null;
  const clock = /\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i.exec(text)?.[1] ?? null;
  const time = [day, clock].filter((part) => part != null).join(" ");
  return {
    service,
    time: time.length > 0 ? time : null,
    customerName: customer,
    stylist,
  };
}

function copyService(service: SalonService): SalonService {
  return { ...service, stylists: [...service.stylists] };
}
