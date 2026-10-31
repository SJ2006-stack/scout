import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentFromHostname, agentFromPathname, hostFor, publicScoutUrl, scoutAgent } from "../src/shared/hosts.ts";
import { healthPayload } from "../src/server/health.ts";

describe("scout hosts", () => {
  it("locks Azure hosts and later specialist domains", () => {
    assert.equal(agentFromHostname("sj-scout.azurewebsites.net"), "main");
    assert.equal(agentFromHostname("sj-event-scout.azurewebsites.net"), "event");
    assert.equal(agentFromHostname("sj-travel-scout.azurewebsites.net"), "travel");
    assert.equal(agentFromHostname("sj-food-scout.azurewebsites.net"), "food");
    assert.equal(agentFromHostname("sj-shop-scout.azurewebsites.net"), "shop");
    assert.equal(agentFromHostname("sj-home-scout.azurewebsites.net"), "home");
    assert.equal(agentFromHostname("event-scout.example.com"), "event");
    assert.equal(agentFromHostname("travel-scout.example.com"), "travel");
    assert.equal(agentFromHostname("food-scout.example.com"), "food");
    assert.equal(agentFromHostname("shop-scout.example.com"), "shop");
    assert.equal(agentFromHostname("home-scout.example.com"), "home");
    assert.equal(agentFromHostname("localhost"), null);
    assert.equal(scoutAgent(undefined), "event");
    assert.equal(scoutAgent("travel"), "travel");
    assert.equal(healthPayload("main").agent, "main");
    assert.equal(hostFor("event"), "https://sj-event-scout.azurewebsites.net");
    assert.equal(agentFromHostname("scout.shrianshjaiswal.me"), "main");
    assert.equal(agentFromPathname("/event-scout"), "event");
    assert.equal(agentFromPathname("/grocery-scout/"), "shop");
    assert.equal(agentFromPathname("/food-scout"), "food");
    assert.equal(agentFromPathname("/travel-scout"), "travel");
    assert.equal(agentFromPathname("/home-scout"), "home");
    assert.equal(agentFromPathname("/appointments-scout"), "appointments");
    assert.equal(agentFromPathname("/"), null);
    assert.equal(publicScoutUrl("event"), "https://scout.shrianshjaiswal.me/event-scout");
    assert.equal(publicScoutUrl("shop"), "https://scout.shrianshjaiswal.me/grocery-scout");
  });
});
