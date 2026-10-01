import { asClass, type AwilixContainer } from "awilix";

import { JobRepository } from "./job-repository.js";
import { JobService } from "./job-service.js";

function registerJob(container: AwilixContainer) {
  container.register({
    // ONE repository rather than a reader/writer pair: this service is the only
    // writer these tables have, so the split would guarantee nothing.
    jobRepository: asClass(JobRepository).singleton(),
    jobService: asClass(JobService).singleton(),
  });
}

export { registerJob };
