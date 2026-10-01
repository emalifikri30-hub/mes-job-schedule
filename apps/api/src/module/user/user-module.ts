import { asClass, type AwilixContainer } from "awilix";

import { KeycloakUserClient } from "./keycloak-user-client.js";
import { UserService } from "./user-service.js";

function registerUser(container: AwilixContainer) {
  container.register({
    keycloakUserClient: asClass(KeycloakUserClient).singleton(),
    // A singleton for the same reason MasterDataService is: the cache lives on
    // the instance.
    userService: asClass(UserService).singleton(),
  });
}

export { registerUser };
