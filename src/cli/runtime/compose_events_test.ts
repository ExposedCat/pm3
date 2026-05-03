import { assertEquals } from "@std/assert";
import {
  getComposeHealthStatus,
  getComposeServiceStatus,
  parsePodmanEvent,
} from "./compose_events.ts";

Deno.test("compose event parses service lifecycle statuses", () => {
  assertEquals(
    getComposeServiceStatus(parsePodmanEvent('{"Status":"start"}')),
    "started",
  );
  assertEquals(
    getComposeServiceStatus(parsePodmanEvent('{"Status":"create"}')),
    "starting",
  );
  assertEquals(
    getComposeServiceStatus(parsePodmanEvent('{"Status":"stop"}')),
    "stopping",
  );
});

Deno.test("compose event parses health statuses", () => {
  assertEquals(
    getComposeHealthStatus(parsePodmanEvent('{"health_status":"starting"}')),
    "starting",
  );
  assertEquals(
    getComposeHealthStatus(
      parsePodmanEvent('{"Status":"health_status: healthy"}'),
    ),
    "healthy",
  );
  assertEquals(
    getComposeHealthStatus(
      parsePodmanEvent('{"Status":"health_status: unhealthy"}'),
    ),
    "degraded",
  );
});
