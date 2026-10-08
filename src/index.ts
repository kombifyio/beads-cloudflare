import { providerFor } from "./auth/provider";

export { TeamStore } from "./tracker/team-store";

export default {
  fetch(request, env, ctx) {
    return providerFor(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
