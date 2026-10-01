import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { setupServer } from "msw/node";
import { HttpResponse, http } from "msw";
import { HTTPException } from "hono/http-exception";

import { KeycloakUserClient } from "./keycloak-user-client.js";
import { UserService } from "./user-service.js";

import type { Logger } from "@molca/utils";
import type { ServiceTokenProvider } from "@molca/mes";

// The people pickers' source, and the three ways it fails in production.
//
// Each failure has a different OWNER, and the message the picker shows is how
// that owner finds out — so each is asserted by its words, not only its status.
// None of them may ever surface as an empty list: "nobody holds this role" and
// "could not ask" look identical in a picker.

const HOST = "http://keycloak.test";
const MEMBERS = `${HOST}/admin/realms/molca/roles/job-manager/users`;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function tokens() {
  let i = 0;
  return {
    getToken: vi.fn(async () => `tok-${i}`),
    invalidate: vi.fn(() => {
      i += 1;
    }),
  } as unknown as ServiceTokenProvider & { invalidate: ReturnType<typeof vi.fn> };
}

const logger = { withMetadata: vi.fn(() => ({ warn: vi.fn() })) } as unknown as Logger;

function setup(timeoutMs = 2_000) {
  const keycloakTokenProvider = tokens();
  const client = new KeycloakUserClient({
    keycloakBaseUrl: `${HOST}/`,
    keycloakRealm: "molca",
    keycloakTimeoutMs: timeoutMs,
    keycloakTokenProvider,
    logger,
  });
  const service = new UserService({
    keycloakUserClient: client,
    jobRoles: { MANAGER: "job-manager", FOREMAN: "job-foreman", AFA: "job-afa" },
    logger,
  });
  return { client, service, keycloakTokenProvider };
}

describe("KeycloakUserClient", () => {
  it("lists enabled members by display name, sorted, with the service token", async () => {
    let auth: string | null = null;
    let url: URL | undefined;
    server.use(
      http.get(MEMBERS, ({ request }) => {
        auth = request.headers.get("Authorization");
        url = new URL(request.url);
        return HttpResponse.json([
          { id: "u-2", username: "budi", firstName: "Budi", lastName: "Santoso" },
          { id: "u-1", username: "ayu.l" },
          { id: "u-3", username: "gone", enabled: false },
        ]);
      }),
    );
    const { client } = setup();

    await expect(client.listRoleMembers("job-manager")).resolves.toEqual([
      { id: "u-1", name: "ayu.l" },
      { id: "u-2", name: "Budi Santoso" },
    ]);
    expect(auth).toBe("Bearer tok-0");
    expect(url?.searchParams.get("briefRepresentation")).toBe("true");
  });

  it("retries once with a fresh token after a 401", async () => {
    let calls = 0;
    server.use(
      http.get(MEMBERS, () => {
        calls += 1;
        return calls === 1 ? new HttpResponse(null, { status: 401 }) : HttpResponse.json([]);
      }),
    );
    const { client, keycloakTokenProvider } = setup();

    await expect(client.listRoleMembers("job-manager")).resolves.toEqual([]);
    expect(keycloakTokenProvider.invalidate).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
  });
});

describe("UserService failures, worded for whoever has to fix them", () => {
  async function failureOf(run: () => Promise<unknown>) {
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HTTPException);
    return err as HTTPException;
  }

  it("names the ROLE when Keycloak says it does not exist (404)", async () => {
    server.use(http.get(MEMBERS, () => new HttpResponse(null, { status: 404 })));
    const { service } = setup();

    const err = await failureOf(() => service.listRoleUsers("MANAGER"));
    expect(err.status).toBe(502);
    expect(err.message).toBe('role "job-manager" (MANAGER) not found in the realm');
  });

  it("names the missing GRANT when the service account is refused (403, twice)", async () => {
    server.use(http.get(MEMBERS, () => new HttpResponse(null, { status: 403 })));
    const { service } = setup();

    const err = await failureOf(() => service.listRoleUsers("MANAGER"));
    expect(err.status).toBe(502);
    expect(err.message).toContain("lacks view-users");
  });

  it("says the directory is unavailable when Keycloak is down and nothing is cached", async () => {
    server.use(http.get(MEMBERS, () => HttpResponse.error()));
    const { service } = setup();

    const err = await failureOf(() => service.listRoleUsers("MANAGER"));
    expect(err.status).toBe(503);
    expect(err.message).toContain("user directory unavailable");
  });

  it("serves the last known list when Keycloak goes down after a success", async () => {
    let up = true;
    server.use(
      http.get(MEMBERS, () =>
        up ? HttpResponse.json([{ id: "u-1", username: "ayu" }]) : HttpResponse.error(),
      ),
    );
    const { service } = setup();
    await service.listRoleUsers("MANAGER");

    up = false;
    vi.useFakeTimers({ now: Date.now() + 10 * 60_000, toFake: ["Date"] });
    try {
      await expect(service.listRoleUsers("MANAGER")).resolves.toEqual([{ id: "u-1", name: "ayu" }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
