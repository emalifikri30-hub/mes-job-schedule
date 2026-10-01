import { Hono } from "hono";

import { WebResponse } from "@molca/network";

import { jobValidator } from "../job/job-dto.js";

import type { AuthEnv, AuthMiddleware } from "@molca/mes";
import type { UserServiceContract } from "./user-service.js";
import type { RoleUser } from "./user.js";

// GET /api/v1/users?role=MANAGER|FOREMAN|AFA — the job dialog's people pickers.
//
// The query names the JOB role, never a realm role name. The mapping from one to
// the other is configuration (JOB_*_ROLE), and letting a caller name a realm
// role directly would turn this route into "list the members of any role in the
// realm" — an admin read this service's account can make and an operator
// should not be able to ask for.

type Deps = {
  userService: UserServiceContract;
  authMw: AuthMiddleware;
};

function createUserHandler({ userService, authMw }: Deps) {
  const app = new Hono<AuthEnv>();
  app.use("*", authMw);

  app.get("/", jobValidator.listUsers, async (c) => {
    const { role } = c.req.valid("query");
    const users = await userService.listRoleUsers(role);
    return c.json(WebResponse.builder<RoleUser[]>().data(users).build(), 200);
  });

  return app;
}

export { createUserHandler };
