// A person who can be named on a job — one member of a Keycloak realm role.
//
// `id` is the Keycloak user id, which is the same value as the `sub` on that
// person's own tokens: the durable identity. `name` is for display, and is what
// gets FROZEN onto job_people at write time.
type RoleUser = {
  id: string;
  name: string;
};

export type { RoleUser };
