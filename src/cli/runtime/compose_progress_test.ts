import { assert } from "@std/assert/assert";
import { assertFalse } from "@std/assert/false";
import { isComposeNoticeLine } from "./compose_progress.ts";

Deno.test("compose notices use the structured log level", () => {
  assertFalse(
    isComposeNoticeLine(
      "DEBUG:podman_compose:podman run --env DEBUG=app:*:warn,app:*:error",
    ),
  );
  assertFalse(
    isComposeNoticeLine(
      "INFO:podman_compose:podman run --env DEBUG=app:*:warn,app:*:error",
    ),
  );
  assertFalse(isComposeNoticeLine('time="now" level=info msg="ignored error"'));
  assertFalse(
    isComposeNoticeLine('time="now" level=information msg="ignored error"'),
  );
  assert(isComposeNoticeLine("WARNING:podman_compose:compose warning"));
  assert(isComposeNoticeLine("ERROR:podman_compose:compose failed"));
  assert(isComposeNoticeLine('time="now" level=warning msg="compose warning"'));
});

Deno.test("compose notices retain unstructured warnings and errors", () => {
  assert(isComposeNoticeLine("Warning: service is missing"));
  assert(isComposeNoticeLine("Error: service failed"));
});
